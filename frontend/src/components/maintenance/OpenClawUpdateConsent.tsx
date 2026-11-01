import type { ToolStatusItem } from '../../api/maintenanceTools';
import { formatAge } from './toolsPresentation';

const CHECKBOX = 'mt-1 h-4 w-4 shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current';
const TICK_ROW = 'flex min-h-[44px] cursor-pointer items-start gap-3 rounded-lg border border-theme-border bg-theme-surface-raised px-3 py-2';

/**
 * The consent review for the OpenClaw core update: exactly what will happen,
 * in order (DESIGN c.1–c.6), before the typed phrase.
 */
export default function OpenClawUpdateConsent({
  tool,
  target,
  channel,
  backup,
  nodeRuntime,
  onNodeRuntimeChange,
  goodTime,
  onGoodTimeChange,
}: {
  tool: ToolStatusItem;
  target: 'recommended' | 'newest';
  channel: string | null;
  backup?: { createdAt: string; ageHours: number } | null;
  nodeRuntime: boolean;
  onNodeRuntimeChange: (value: boolean) => void;
  goodTime: boolean;
  onGoodTimeChange: (value: boolean) => void;
}) {
  const version = target === 'recommended' ? tool.recommended.version : null;
  // K7: the latest pre-flight says whether chat stays up until the switch-over (live) or is down throughout (stopped).
  const mode = tool.updateMode?.mode ?? null;
  const steps = [
    `Checks first: OpenClaw's health, free disk space, Node.js, Portal plugins and a verified maintenance backup. If any check fails, nothing is changed and you see the reason.`,
    ...(nodeRuntime ? ['Node.js is updated to the newest 24.x release the new OpenClaw needs. The running OpenClaw keeps working on the old one until its restart.'] : []),
    'The Portal\'s OpenClaw plugins are prepared for the new version.',
    mode === 'stopped'
      ? 'The OpenClaw gateway is stopped first, so chat is unavailable from here to the end. OpenClaw then installs the new version and tests it on a copy of its data.'
      : mode === 'live'
        ? 'OpenClaw installs the new version and tests it on a copy of its data. Chats keep working during this step.'
        : 'OpenClaw installs the new version and tests it on a copy of its data. Chats keep working during this step, unless the checks find the installed OpenClaw can\'t hand over while chat runs: then the gateway is stopped first and chat is unavailable for the whole update.',
    mode === 'stopped'
      ? 'OpenClaw switches over and finishes its maintenance, then the gateway starts again and chat returns.'
      : 'OpenClaw switches over: the gateway stops while OpenClaw finishes its maintenance, then starts again. Active chats pause for this step, usually a few minutes.',
    'The Portal checks its chat features against the new version.',
  ];
  const goodTimeText = mode === 'stopped'
    ? 'This is a good time: people using chat know it will be unavailable for the whole update.'
    : mode === 'live'
      ? 'This is a good time: people using chat know it will pause during the switch-over, usually for a few minutes.'
      : 'This is a good time: people using chat know it will pause during the update, possibly for all of it.';
  return (
    <div className="space-y-3 text-xs leading-5 text-theme-text">
      <p>
        OpenClaw {tool.installed.version || ''} will be updated to {version || 'the newest release'}
        {channel ? ` from the ${channel} channel` : ''}. This can take up to 2 hours on large installations.
      </p>
      <section aria-labelledby="openclaw-consent-steps">
        <h3 id="openclaw-consent-steps" className="font-semibold">What will happen</h3>
        <ol aria-label="What will happen" className="mt-1 list-decimal space-y-1 pl-4">
          {steps.map((step) => <li key={step}>{step}</li>)}
        </ol>
      </section>
      <section aria-labelledby="openclaw-consent-rollback">
        <h3 id="openclaw-consent-rollback" className="font-semibold">If something goes wrong</h3>
        <p>
          If OpenClaw's own checks fail, or the new version does not start or answer the Portal's chat checks, it automatically returns to {tool.installed.version || 'the current version'} and the page says why.
          If only the check for agents&apos; questions fails, OpenClaw stays on the new version with chat working, and the card shows &quot;Some features off&quot; with Retry checks.
          If it cannot return safely, the page shows &quot;Recovery required&quot; with the one action that continues (OpenClaw repair, or Retry checks when the new version is running again), and no other update is offered until that is done.
        </p>
      </section>
      <p data-testid="openclaw-consent-backup">
        {backup
          ? `Backup first: the latest verified maintenance backup (${formatAge(backup.createdAt) || `${backup.ageHours} h`} old) is recorded with this update. It covers Portal data; OpenClaw keeps its own rollback copy.`
          : 'Backup first: no verified maintenance backup was found. Create one before starting, or the server will refuse the update.'}
      </p>
      <p data-testid="openclaw-consent-plugins">
        Typing the confirmation also accepts the capabilities of the Portal&apos;s own OpenClaw plugins when they are reloaded for
        the new version (only the plugins this Portal release ships; OpenClaw&apos;s --accept-capabilities). Other plugins are not changed.
      </p>
      <label className={TICK_ROW}>
        <input type="checkbox" className={CHECKBOX} checked={nodeRuntime} onChange={(event) => onNodeRuntimeChange(event.target.checked)} />
        <span>
          Also update Node.js if the new OpenClaw needs a newer version. Only for Node.js installed from NodeSource; otherwise the checks stop and say so.
        </span>
      </label>
      <label className={TICK_ROW}>
        <input type="checkbox" className={CHECKBOX} checked={goodTime} onChange={(event) => onGoodTimeChange(event.target.checked)} />
        <span>{goodTimeText}</span>
      </label>
    </div>
  );
}
