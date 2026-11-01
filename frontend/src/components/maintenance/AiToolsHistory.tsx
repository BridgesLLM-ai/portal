import { useState } from 'react';
import { maintenanceToolsAPI, type ToolsHistoryEntry, type ToolsRunReport } from '../../api/maintenanceTools';
import { formatDuration, stepDetailText } from './toolsPresentation';

const OUTCOME_LABELS: Record<string, string> = {
  succeeded: 'Updated',
  'succeeded-degraded': 'Updated, checks failed',
  refused: 'Not updated',
  'rolled-back': 'Rolled back',
  'recovery-required': 'Recovery required',
  failed: 'Failed',
};

const ACTION_LABELS: Record<string, string> = {
  update: 'update',
  preflight: 'pre-flight',
  requalify: 're-check',
  'recover-native': 'repair',
  'retry-checks': 'feature checks',
};

/** Only an update run is "Updated" / "Not updated"; a Re-check or pre-flight is labelled by its own result. */
export function historyOutcomeLabel(entry: Pick<ToolsHistoryEntry, 'outcome' | 'action'>): string {
  if (entry.action === 'requalify' && (entry.outcome === 'succeeded' || entry.outcome === 'refused')) {
    return entry.outcome === 'succeeded' ? 'Checked — passed' : 'Checked — not confirmed';
  }
  if ((entry.outcome === 'succeeded' || entry.outcome === 'refused') && entry.action && entry.action !== 'update') {
    return `${(ACTION_LABELS[entry.action] || entry.action).replace(/^./, (c) => c.toUpperCase())} ${entry.outcome === 'succeeded' ? 'passed' : 'refused'}`;
  }
  return OUTCOME_LABELS[entry.outcome] || entry.outcome;
}

/** The Change column: from → to only for an update; a check or pre-flight changes nothing. */
export function historyChangeText(entry: Pick<ToolsHistoryEntry, 'action' | 'from' | 'to'>): string {
  return entry.action === 'update' && entry.from && entry.to ? `${entry.from} → ${entry.to}` : '—';
}

const BUTTON = 'inline-flex min-h-[36px] items-center rounded-lg border border-theme-border bg-theme-surface-raised px-2 py-1 text-[11px] font-medium text-theme-text transition hover:bg-theme-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current disabled:opacity-50';

export default function AiToolsHistory({
  history,
  toolLabels,
  owner,
  currentUserId,
}: {
  history: ToolsHistoryEntry[];
  toolLabels: Record<string, string>;
  owner: boolean;
  currentUserId?: string | null;
}) {
  const [report, setReport] = useState<{ runId: string; data: ToolsRunReport | null; error: string | null } | null>(null);
  const [loadingRunId, setLoadingRunId] = useState<string | null>(null);

  const openReport = async (runId: string) => {
    setLoadingRunId(runId);
    try {
      setReport({ runId, data: await maintenanceToolsAPI.getRunReport(runId), error: null });
    } catch (error: any) {
      setReport({ runId, data: null, error: String(error?.response?.data?.error || 'The report could not be read.').slice(0, 300) });
    } finally {
      setLoadingRunId(null);
    }
  };

  return (
    <section id="ai-tools-history" aria-labelledby="ai-tools-history-heading" className="space-y-2">
      <h3 id="ai-tools-history-heading" className="text-xs font-semibold text-theme-text">Update history</h3>
      {history.length === 0 ? (
        <p className="text-[11px] text-theme-text-muted">No AI tool updates have run yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-theme-border">
          <table className="w-full min-w-[640px] text-left text-[11px] text-theme-text-muted">
            <caption className="sr-only">AI tools update history, newest first</caption>
            <thead className="bg-theme-surface-raised text-theme-text">
              <tr>
                <th scope="col" className="px-2 py-1.5 font-medium">Date</th>
                <th scope="col" className="px-2 py-1.5 font-medium">Tool</th>
                <th scope="col" className="px-2 py-1.5 font-medium">Change</th>
                <th scope="col" className="px-2 py-1.5 font-medium">Outcome</th>
                <th scope="col" className="px-2 py-1.5 font-medium">Duration</th>
                <th scope="col" className="px-2 py-1.5 font-medium">Started by</th>
                <th scope="col" className="px-2 py-1.5 font-medium">Report</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.runId} className="border-t border-theme-border">
                  <td className="px-2 py-1.5">{entry.startedAt ? new Date(entry.startedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td>
                  <td className="px-2 py-1.5 text-theme-text">{toolLabels[entry.tool] || entry.tool}</td>
                  <td className="px-2 py-1.5">{historyChangeText(entry)}</td>
                  <td className="px-2 py-1.5 text-theme-text">{historyOutcomeLabel(entry)}</td>
                  <td className="px-2 py-1.5">{formatDuration(entry.durationMs)}</td>
                  <td className="px-2 py-1.5">{entry.initiator ? (entry.initiator === currentUserId ? 'You' : 'Owner') : 'Server'}</td>
                  <td className="px-2 py-1.5">
                    {owner ? (
                      <button type="button" className={BUTTON} disabled={loadingRunId === entry.runId}
                        onClick={() => { void openReport(entry.runId); }}
                        aria-label={`Report for the ${toolLabels[entry.tool] || entry.tool} run of ${entry.startedAt ? new Date(entry.startedAt).toLocaleString() : 'unknown date'}`}>
                        View
                      </button>
                    ) : 'Owner only'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {report && (
        <div role="region" aria-label="Run report" className="rounded-lg border border-theme-border bg-theme-surface-raised px-3 py-2 text-[11px] text-theme-text-muted">
          {report.error ? <p role="alert">{report.error}</p> : report.data && (
            <>
              <p className="text-theme-text">
                {toolLabels[report.data.run.tool] || report.data.run.tool}: {historyOutcomeLabel({
                  outcome: report.data.run.state,
                  action: history.find((entry) => entry.runId === report.runId)?.action ?? null,
                })}
                {report.data.run.error?.message ? ` — ${report.data.run.error.message}` : ''}
              </p>
              {report.data.run.steps.length > 0 && (
                <ol aria-label="Run steps" className="mt-1 list-decimal pl-4">
                  {report.data.run.steps.map((step) => (
                    <li key={step.id}>{step.label}: {step.state}{step.detail ? ` — ${stepDetailText(step.detail)}` : ''}</li>
                  ))}
                </ol>
              )}
              <p className="mt-1">Evidence kept on the server: {report.data.evidence.join(', ') || 'none'}.</p>
            </>
          )}
          <button type="button" className={`${BUTTON} mt-2`} onClick={() => setReport(null)}>Close report</button>
        </div>
      )}
    </section>
  );
}
