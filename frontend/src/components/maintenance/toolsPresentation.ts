import type { ToolRunContract, ToolStatusItem } from '../../api/maintenanceTools';

export type ToolTone = 'good' | 'info' | 'attention' | 'bad' | 'progress' | 'neutral';

/** Status tones; neutral surfaces use the theme variables, tones only tint them. */
export const TOOL_TONE_CLASSES: Record<ToolTone, string> = {
  good: 'border-emerald-500/30 bg-emerald-500/10 text-theme-text',
  info: 'border-cyan-500/30 bg-cyan-500/10 text-theme-text',
  attention: 'border-amber-500/30 bg-amber-500/10 text-theme-text',
  bad: 'border-red-500/30 bg-red-500/10 text-theme-text',
  progress: 'border-blue-500/30 bg-blue-500/10 text-theme-text',
  neutral: 'border-theme-border bg-theme-surface-raised text-theme-text-muted',
};

/** The plain state an owner reads on a card. */
export function toolStatusChip(item: ToolStatusItem): { label: string; tone: ToolTone } {
  switch (item.status) {
    case 'ok': return item.newerThanTested ? { label: 'Newer than tested', tone: 'info' } : { label: 'Current', tone: 'good' };
    case 'update-available': return { label: 'Update available', tone: 'attention' };
    // Behind, but it can't update itself under the Portal (N3): it keeps working; nothing here can update it.
    case 'needs-portal-release': return { label: 'Needs a later Portal release', tone: 'info' };
    case 'below-floor': return { label: 'Update required', tone: 'bad' };
    case 'drifted-requalifying': return { label: 'Changed itself — re-check', tone: 'attention' };
    case 'drifted-failed': return { label: 'Re-check failed', tone: 'bad' };
    case 'degraded': return { label: 'Some features off', tone: 'attention' };
    case 'blocked': return { label: 'Blocked', tone: 'bad' };
    case 'updating': return { label: 'Updating', tone: 'progress' };
    case 'failed-last-run':
      return item.lastRun?.state === 'rolled-back'
        ? { label: 'Rolled back', tone: 'attention' }
        : { label: 'Last update failed', tone: 'attention' };
    case 'recovery-required': return { label: 'Recovery open', tone: 'bad' };
    case 'unknown-retrying': return { label: 'Checking', tone: 'neutral' };
    // Installed, but nothing has read its version yet: only its Re-check is offered.
    case 'not-checked': return { label: 'Not checked yet', tone: 'neutral' };
    case 'not-installed': return { label: 'Not installed', tone: 'neutral' };
    default: return { label: 'Unknown', tone: 'neutral' };
  }
}

/** Re-check records that vouch for a program without comparing its bytes to a download (by record authority). */
const UNVERIFIED_BYTES_BADGES: Readonly<Record<string, string>> = {
  // Vendor programs (Grok Build, Antigravity): no published checksum to compare with.
  'probes-only': 'Re-checked by its probes; the vendor publishes no checksum',
  'vendor-self-update': 'Re-checked by its probes; the vendor publishes no checksum',
  // Hermes re-check: the installed release's attestation and commit were compared; nothing was downloaded to compare bytes.
  'github-tag-commit': 'Re-checked; the installed files were compared, not downloaded',
};

export function admissionBadge(installed: ToolStatusItem['installed']): string | null {
  if (installed.bytesVerified === false && installed.admission !== 'none') {
    // Any other authority (e.g. Ollama's re-check of GitHub's digest record) gets the weaker plain statement.
    return UNVERIFIED_BYTES_BADGES[installed.authority || '']
      || 'Re-checked by its probes; its files were not compared with the official download';
  }
  switch (installed.admission) {
    case 'proven': return 'Proven';
    case 'verified': return 'Verified source';
    case 'requalified': return 'Re-qualified';
    case 'unverified': return 'Unverified';
    default: return null;
  }
}

const OLLAMA_IMPACT = 'Restarts the local model server; your models are kept.';

/** The OpenClaw consent dialog states the update mode only from a pre-flight that passed this recently (N2). */
export const OPENCLAW_PREFLIGHT_FRESH_MS = 30 * 60_000;

export function openClawPreflightFresh(item: Pick<ToolStatusItem, 'preflightPassedAt'>, nowMs = Date.now()): boolean {
  const passedAt = item.preflightPassedAt ? Date.parse(item.preflightPassedAt) : Number.NaN;
  return Number.isFinite(passedAt) && nowMs - passedAt <= OPENCLAW_PREFLIGHT_FRESH_MS;
}

/** g.2: every card says what its update does to OpenClaw; for OpenClaw, in the update mode its pre-flight recorded (K7). */
/** The card's "Newest" cell. 5.2.0 updates every tool but the npm CLIs only to its qualified version, so it never
 *  reads as if a newer version could be checked for or installed from here. */
export function newestLine(item: Pick<ToolStatusItem, 'newest' | 'newestNotOffered'>): string {
  if (item.newestNotOffered) {
    return item.newest.version
      ? `${item.newest.version} is not offered from Maintenance in this release`
      : 'Not offered from Maintenance in this release';
  }
  return item.newest.version || 'not checked yet';
}

export function toolImpactLine(item: Pick<ToolStatusItem, 'id' | 'restartsGateway' | 'updateMode'>): string {
  if (item.restartsGateway) {
    if (item.updateMode?.mode === 'stopped') {
      return 'Stops OpenClaw for the whole update; chat is unavailable until it starts again; large installations can take up to 2 hours.';
    }
    if (item.updateMode?.mode === 'live') {
      return 'Restarts OpenClaw; active chats pause for a few minutes while it switches over; large installations can take up to 2 hours.';
    }
    // No pre-flight yet: it decides whether chat stays up until the switch-over or stops for the whole update.
    return 'Restarts OpenClaw; chat pauses for the switch-over, or for the whole update if the installed OpenClaw needs that; large installations can take up to 2 hours.';
  }
  if (item.id === 'ollama') return OLLAMA_IMPACT;
  return 'No OpenClaw restart.';
}

/** What a non-OpenClaw update (or the install of a missing tool) does, in the confirm dialog (g.2; the OpenClaw
 *  review has its own steps). */
export function toolConfirmNotice(item: Pick<ToolStatusItem, 'id'>, install = false): string {
  if (install) {
    if (item.id === 'ollama') return 'Installs the local model server and starts it. No OpenClaw restart.';
    if (item.id === 'hermes') {
      return 'Builds it from its official source (downloads its source, uv and Python; a few minutes); the OpenClaw gateway is not touched. If its checks fail, what was installed is removed again.';
    }
    return 'No OpenClaw restart. If its checks fail after it is installed, what was installed is removed again.';
  }
  if (item.id === 'ollama') return OLLAMA_IMPACT;
  if (item.id === 'hermes') {
    return 'Builds the new version next to the current one (downloads its source, uv and Python; a few minutes) and switches only at the end; the OpenClaw gateway is not touched.';
  }
  return 'No OpenClaw restart. The previous version is kept so the update can be undone if its checks fail.';
}

/**
 * Why a probe was not needed on this server, by probe id. toolctl records the state
 * `not-required` only in the step text ("…; not required here: C-APP."), and today only
 * for C-APP: Codex's app-server is checked only while OpenClaw's Codex plugin is pointed
 * at this CLI (DESIGN d.6); otherwise the plugin runs its own bundled Codex.
 */
const PROBE_NOT_NEEDED_REASONS: Readonly<Record<string, string>> = {
  'C-APP': 'OpenClaw uses its own Codex',
};

/** A run step's detail in owner words: "not required here: <ids>" reads "Not needed here: <id> (<reason>)". */
export function stepDetailText(detail: string): string {
  return detail.replace(/; not required here: ([A-Za-z0-9-]+(?:, [A-Za-z0-9-]+)*)\./, (_match, list: string) => `. ${list
    .split(', ')
    .map((id) => `Not needed here: ${id}${PROBE_NOT_NEEDED_REASONS[id] ? ` (${PROBE_NOT_NEEDED_REASONS[id]})` : ''}`)
    .join('. ')}.`);
}

/**
 * The Details line about the required checks. This release records no per-check list (`capabilities` stays empty), so
 * an empty list reads from the last run, never "none recorded yet" right after checks passed.
 */
export function checksDetailLine(tool: Pick<ToolStatusItem, 'capabilities' | 'lastRun'>): string {
  const { passed, failed } = tool.capabilities.required;
  if (passed.length || failed.length) {
    return `Checks passed: ${passed.length ? passed.join(', ') : 'none'}${failed.length ? ` · failed: ${failed.join(', ')}` : ''}`;
  }
  const run = tool.lastRun;
  if (!run) return 'Checks: none run yet.';
  if (run.state === 'succeeded') {
    return run.action === 'preflight' ? 'Checks: the last pre-flight passed.' : 'Checks: all required checks passed in the last run.';
  }
  return 'Checks: see the last run above.';
}

/** An OpenClaw run's feature checks for the card's Details, one plain line each (toolctl wording). */
export function contractDetailLines(contract: ToolRunContract): string[] {
  const lines = Object.entries(contract.featuresOff)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([feature, methods]) => `Off: ${feature} (${methods.join(', ')} not offered)`);
  if (contract.missingMethods.length) {
    lines.push(`Missing required method${contract.missingMethods.length === 1 ? '' : 's'}: ${contract.missingMethods.join(', ')}`);
  }
  lines.push(contract.methods.state === 'not-run'
    ? `Gateway methods: not checked${contract.methods.reason ? ` — ${contract.methods.reason}` : ''}`
    : 'Gateway methods: checked');
  return lines;
}

export function formatAge(fromIso: string | null | undefined, nowMs = Date.now()): string | null {
  if (!fromIso) return null;
  const ms = nowMs - Date.parse(fromIso);
  if (!Number.isFinite(ms)) return null;
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'less than a minute';
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
