import type { ToolStatusItem } from '../../api/maintenanceTools';
import AiToolRunResult, { acceptedNextAction, type ToolNextAction } from './AiToolRunResult';
import {
  TOOL_TONE_CLASSES,
  admissionBadge,
  checksDetailLine,
  contractDetailLines,
  formatAge,
  newestLine,
  toolImpactLine,
  toolStatusChip,
} from './toolsPresentation';

/** What the owner should expect from chat during an OpenClaw update, or null when no pre-flight said. */
export function updateModeLine(tool: ToolStatusItem): string | null {
  const mode = tool.updateMode;
  if (!tool.restartsGateway || !mode) return null;
  if (mode.mode === 'live') {
    return 'During the update chat keeps working until OpenClaw switches over; then it pauses for a few minutes.';
  }
  const why = mode.reason === 'service-inspection'
    ? 'the installed OpenClaw can\'t check its own service while chat runs'
    : 'the installed OpenClaw can\'t hand over while chat stays up';
  return `Chat will be unavailable for the whole update: ${why}, so the gateway is stopped first and started again at the end.`;
}

export type ToolCardRequest =
  | { kind: 'update'; tool: ToolStatusItem; target: 'recommended' | 'newest' }
  | { kind: 'requalify'; tool: ToolStatusItem }
  | { kind: 'install'; tool: ToolStatusItem }
  | { kind: 'preflight'; tool: ToolStatusItem };

const BUTTON = 'inline-flex min-h-[40px] items-center justify-center rounded-lg border px-3 py-2 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY = `${BUTTON} border-theme-border-strong bg-theme-surface-strong text-theme-text hover:bg-theme-surface-hover`;
const SECONDARY = `${BUTTON} border-theme-border bg-theme-surface text-theme-text-muted hover:bg-theme-surface-hover`;

export default function AiToolCard({
  tool,
  owner,
  busy,
  recoveryOpen = false,
  onRequest,
  onNextAction,
}: {
  tool: ToolStatusItem;
  owner: boolean;
  busy: boolean;
  /** P7: never offer a change while recovery is open, whatever the item lists. */
  recoveryOpen?: boolean;
  onRequest: (request: ToolCardRequest) => void;
  onNextAction: (tool: ToolStatusItem, action: ToolNextAction) => void;
}) {
  const chip = toolStatusChip(tool);
  const badge = admissionBadge(tool.installed);
  const disabled = !owner || busy;
  const ownerNoteId = `ai-tool-${tool.id}-owner-note`;
  const lastRun = tool.lastRun;
  const offersUpdateRecommended = !recoveryOpen && tool.actions.includes('update-recommended') && tool.runActions.includes('update');
  const offersUpdateNewest = !recoveryOpen && tool.actions.includes('update-newest') && tool.runActions.includes('update');
  const offersRequalify = !recoveryOpen && tool.actions.includes('requalify') && tool.runActions.includes('requalify');
  // A missing tool: Install its recommended version (owner only; admins see it disabled).
  const offersInstall = !recoveryOpen && Boolean(tool.installVersion) && tool.actions.includes('install')
    && tool.runActions.includes('install');
  const offersCheck = !recoveryOpen && tool.restartsGateway && tool.runActions.includes('preflight');
  const modeLine = updateModeLine(tool);
  // Mode B: the mode line (with its reason) says what the impact line would, so only one is shown.
  const chatDownWholeUpdate = Boolean(modeLine) && tool.updateMode?.mode === 'stopped';
  // No update can run (held for a later Portal release, or its own updater refuses here): no restart to describe.
  const noUpdateImpact = tool.restartsGateway && (tool.heldForLaterRelease === true || tool.status === 'needs-portal-release');
  // "Some features off" keeps its Retry checks when a later pre-flight or refusal is the last run shown above.
  const offersRetryChecks = !recoveryOpen && tool.status === 'degraded' && tool.runActions.includes('retry-checks')
    && acceptedNextAction(tool, lastRun?.nextAction ?? null) !== 'retry-checks';
  const anyAction = offersRetryChecks || offersUpdateRecommended || offersUpdateNewest || offersRequalify || offersInstall || offersCheck;

  return (
    <article
      aria-labelledby={`ai-tool-${tool.id}-name`}
      className="flex flex-col gap-3 rounded-xl border border-theme-border bg-theme-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`ai-tool-${tool.id}-name`} className="text-sm font-semibold text-theme-text">{tool.label}</h3>
          {tool.status !== 'not-installed' && <p className="mt-0.5 text-xs text-theme-text-muted">
            {tool.installed.version ? `Installed ${tool.installed.version}` : 'Installed version unknown'}
            {badge && (
              <span className="ml-2 rounded-md border border-theme-border bg-theme-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-theme-text-muted">
                {badge}
              </span>
            )}
          </p>}
        </div>
        <span
          data-testid={`ai-tool-${tool.id}-chip`}
          className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${TOOL_TONE_CLASSES[chip.tone]}`}
        >
          {chip.label}
        </span>
      </div>

      <dl className="grid grid-cols-3 gap-2 text-[11px]">
        <div>
          <dt className="text-theme-text-subtle">Recommended</dt>
          <dd className="text-theme-text">{tool.recommended.version || '—'}{tool.recommended.version && !tool.recommended.proven ? ' (not yet qualified)' : ''}</dd>
        </div>
        <div>
          <dt className="text-theme-text-subtle">Newest</dt>
          <dd className="text-theme-text" data-testid={`ai-tool-${tool.id}-newest`}>{newestLine(tool)}</dd>
        </div>
        <div>
          <dt className="text-theme-text-subtle">Minimum</dt>
          <dd className="text-theme-text">{tool.floor}</dd>
        </div>
      </dl>

      <p className="text-xs leading-5 text-theme-text">{tool.statusReason}</p>
      {tool.lastGoodAt && (
        <p className="text-[11px] text-theme-text-muted">Showing the last confirmed result from {formatAge(tool.lastGoodAt)} ago.</p>
      )}
      {!chatDownWholeUpdate && !noUpdateImpact && <p className="text-[11px] text-theme-text-muted">{toolImpactLine(tool)}</p>}
      {modeLine && (
        <p data-testid={`ai-tool-${tool.id}-update-mode`} className="text-[11px] text-theme-text">{modeLine}</p>
      )}
      {tool.diskCheck && tool.diskCheck.messages.length > 0 && (
        <p data-testid={`ai-tool-${tool.id}-disk`} className="text-[11px] text-theme-text">
          Disk space (latest pre-flight{formatAge(tool.diskCheck.checkedAt) ? `, ${formatAge(tool.diskCheck.checkedAt)} ago` : ''}): {tool.diskCheck.messages.join(' ')}
        </p>
      )}
      {tool.status !== 'updating' && (
        <AiToolRunResult tool={tool} owner={owner} busy={busy} onNextAction={(action) => onNextAction(tool, action)} />
      )}

      {anyAction && (
        <div className="flex flex-wrap gap-2">
          {offersRetryChecks && (
            <button type="button" className={PRIMARY} disabled={disabled} aria-describedby={!owner ? ownerNoteId : undefined}
              onClick={() => onNextAction(tool, 'retry-checks')}>
              Retry checks
            </button>
          )}
          {offersRequalify && (
            // On a current card the Re-check is a choice (N6), not the next step, so it is not the primary button.
            <button type="button" className={tool.status === 'ok' ? SECONDARY : PRIMARY} disabled={disabled}
              aria-describedby={!owner ? ownerNoteId : undefined}
              onClick={() => onRequest({ kind: 'requalify', tool })}>
              Re-check {tool.label}
            </button>
          )}
          {offersInstall && (
            <button type="button" className={PRIMARY} disabled={disabled} aria-describedby={!owner ? ownerNoteId : undefined}
              onClick={() => onRequest({ kind: 'install', tool })}>
              Install {tool.label} {tool.installVersion}
            </button>
          )}
          {offersUpdateRecommended && (
            <button type="button" className={PRIMARY} disabled={disabled} aria-describedby={!owner ? ownerNoteId : undefined}
              onClick={() => onRequest({ kind: 'update', tool, target: 'recommended' })}>
              Update {tool.label} to {tool.recommended.version}
            </button>
          )}
          {offersUpdateNewest && (
            <button type="button" className={SECONDARY} disabled={disabled} aria-describedby={!owner ? ownerNoteId : undefined}
              onClick={() => onRequest({ kind: 'update', tool, target: 'newest' })}>
              Update {tool.label} to newest
            </button>
          )}
          {offersCheck && (
            <button type="button" className={SECONDARY} disabled={disabled} aria-describedby={!owner ? ownerNoteId : undefined}
              onClick={() => onRequest({ kind: 'preflight', tool })}>
              Check whether {tool.label} can update
            </button>
          )}
        </div>
      )}
      {anyAction && !owner && (
        <p id={ownerNoteId} className="text-[11px] text-theme-text-muted">Only the Owner can change the server.</p>
      )}

      <details className="rounded-lg border border-theme-border bg-theme-surface-raised px-3 py-2 text-[11px] text-theme-text-muted">
        <summary className="cursor-pointer rounded text-theme-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-current">Details</summary>
        <div className="mt-2 space-y-1">
          <p>{checksDetailLine(tool)}</p>
          {tool.capabilities.optionalOff.length > 0 && <p>Features off: {tool.capabilities.optionalOff.join(', ')}</p>}
          {lastRun?.contract && (
            <ul aria-label="Portal feature checks" className="space-y-0.5">
              {contractDetailLines(lastRun.contract).map((line) => <li key={line}>{line}</li>)}
            </ul>
          )}
          <p>
            Source: {tool.installed.source === 'admission-record' ? 'verified admission record' : tool.installed.source === 'package-json' ? 'installed package' : tool.installed.source === 'last-check' ? 'read by the last Re-check' : 'not read'}
            {tool.installed.admittedAt ? ` · admitted ${new Date(tool.installed.admittedAt).toLocaleString()}` : ''}
          </p>
          <p>
            Last run: {lastRun ? `${lastRun.action || 'run'} ${lastRun.state}${lastRun.endedAt ? `, ${new Date(lastRun.endedAt).toLocaleString()}` : ''}` : 'none'}
            {lastRun?.message ? ` — ${lastRun.message}` : ''}
          </p>
          <p><a href="#ai-tools-history" className="underline underline-offset-2">Update history</a></p>
        </div>
      </details>
    </article>
  );
}
