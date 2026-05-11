export type LifecycleMaintenanceSignal = 'idle' | 'maintenance' | 'maintenance_done' | 'compacting' | 'compacted';

const LIFECYCLE_CONTROL_TOKENS = new Set([
  'start',
  'started',
  'running',
  'end',
  'ended',
  'complete',
  'completed',
  'error',
  'failed',
  'idle',
  'compacting',
  'compacted',
]);

const LIFECYCLE_FLUSH_PREPARING_RE = /\b(memory flush (?:about to start|starting|started|queued|pending)|preparing (?:for )?(?:a )?memory flush|preparing context maintenance|preparing compaction|preparing to store durable memor(?:y|ies)|about to compact|pre-compaction|heartbeat check (?:started|starting|running|queued|pending)|checking heartbeat|reading heartbeat\.md|read heartbeat\.md)\b/i;
const LIFECYCLE_FLUSH_RUNNING_RE = /\b(memory flush(?:ing)?|flush in progress|flushing memory|storing durable memor(?:y|ies)|writing durable memor(?:y|ies)|context maintenance|refreshing (?:context|memory)|summariz(?:ing|ation) (?:context|conversation|history)|trimming context)\b/i;
const LIFECYCLE_FLUSH_DONE_RE = /\b(memory flush complete(?:d)?|durable memor(?:y|ies) (?:stored|written)|context refreshed|context maintenance (?:finished|complete(?:d)?)|compaction (?:incomplete|did not complete)|heartbeat check complete(?:d)?|heartbeat_ok)\b/i;
const LIFECYCLE_COMPACTING_RE = /^(?:compacting context[.…]*|auto-compaction(?: started| in progress)?[.…]*|context compaction(?: started| in progress)?[.…]*|compaction (?:in progress|started)\.?)$/i;
const LIFECYCLE_COMPACTED_RE = /^(?:context compacted\.?|auto-compaction complete(?:d)?\.?|context compaction complete(?:d)?\.?|compaction (?:complete(?:d)?|finished)\.?)$/i;

function normalizeLifecycleMarker(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

export interface MaintenanceRailResolution {
  isMaintenanceStatus: boolean;
  signal: LifecycleMaintenanceSignal;
  displayStatusText: string | null;
  update: {
    phase: 'start' | 'end';
    content: string | null;
    completed?: boolean;
    maintenanceKind: 'compaction' | 'maintenance';
  } | null;
}

export function extractLifecycleStatusText(data: any): string | null {
  const candidates = [
    data?.statusText,
    data?.message,
    data?.text,
    data?.content,
    data?.detail,
    data?.description,
    data?.status,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const next = candidate.trim();
    if (!next) continue;
    if (LIFECYCLE_CONTROL_TOKENS.has(next.toLowerCase())) continue;
    return next;
  }

  return null;
}

export function inferLifecycleMaintenanceSignal(phase: string, statusText: string | null): LifecycleMaintenanceSignal {
  const normalizedPhase = String(phase || '').trim().toLowerCase();
  const normalizedStatus = normalizeLifecycleMarker(String(statusText || ''));

  const phaseClaimsCompaction = normalizedPhase === 'compacted'
    || normalizedPhase === 'compaction_end'
    || normalizedPhase === 'compaction_completed'
    || normalizedPhase === 'compacting'
    || normalizedPhase === 'compaction_start'
    || normalizedPhase === 'compaction_started';
  const statusContradictsCompaction = Boolean(normalizedStatus && phaseClaimsCompaction && !/^(?:context compacted\.?|compacting context[.…]*|auto-compaction(?: started| in progress| complete(?:d)?)?[.…]*|context compaction(?: started| in progress| complete(?:d)?)?[.…]*|compaction (?:in progress|started|complete(?:d)?|finished)\.?)$/i.test(normalizedStatus));
  if (!statusContradictsCompaction && (normalizedPhase === 'compacted' || normalizedPhase === 'compaction_end' || normalizedPhase === 'compaction_completed')) {
    return 'compacted';
  }
  if (!statusContradictsCompaction && (normalizedPhase === 'compacting' || normalizedPhase === 'compaction_start' || normalizedPhase === 'compaction_started')) {
    return 'compacting';
  }
  if (!normalizedStatus) return 'idle';
  if (LIFECYCLE_COMPACTED_RE.test(normalizedStatus)) return 'compacted';
  if (LIFECYCLE_COMPACTING_RE.test(normalizedStatus)) return 'compacting';
  if (LIFECYCLE_FLUSH_DONE_RE.test(normalizedStatus)) return 'maintenance_done';
  if (LIFECYCLE_FLUSH_PREPARING_RE.test(normalizedStatus) || LIFECYCLE_FLUSH_RUNNING_RE.test(normalizedStatus)) return 'maintenance';
  return 'idle';
}

export function defaultLifecycleStatusText(signal: LifecycleMaintenanceSignal): string {
  if (signal === 'compacting') return 'Compacting context…';
  if (signal === 'compacted') return 'Context compacted';
  if (signal === 'maintenance') return 'Preparing context maintenance…';
  if (signal === 'maintenance_done') return 'Context maintenance finished.';
  return 'Agent is thinking…';
}

export function resolveMaintenanceRailStatus(data: any): MaintenanceRailResolution {
  const nextStatusText = typeof data?.content === 'string' ? data.content : extractLifecycleStatusText(data);
  const lifecyclePhase = String(data?.phase || data?.status || '').toLowerCase();
  const lifecycleSignal = data?.maintenanceKind === 'maintenance'
    ? inferLifecycleMaintenanceSignal(lifecyclePhase, nextStatusText || defaultLifecycleStatusText('maintenance'))
    : inferLifecycleMaintenanceSignal(lifecyclePhase, nextStatusText);
  const isMaintenanceStatus = data?.maintenanceKind === 'maintenance'
    || lifecycleSignal === 'maintenance'
    || lifecycleSignal === 'maintenance_done'
    || lifecycleSignal === 'compacting'
    || lifecycleSignal === 'compacted';
  const displayStatusText = nextStatusText || (isMaintenanceStatus
    ? defaultLifecycleStatusText(lifecycleSignal === 'idle' ? 'maintenance' : lifecycleSignal)
    : null);

  let update: MaintenanceRailResolution['update'] = null;
  if (isMaintenanceStatus) {
    if (lifecycleSignal === 'compacted') {
      update = {
        phase: 'end',
        content: displayStatusText,
        completed: true,
        maintenanceKind: 'compaction',
      };
    } else if (lifecycleSignal === 'maintenance_done') {
      update = {
        phase: 'end',
        content: displayStatusText,
        completed: false,
        maintenanceKind: 'maintenance',
      };
    } else {
      update = {
        phase: 'start',
        content: displayStatusText,
        maintenanceKind: lifecycleSignal === 'compacting' ? 'compaction' : 'maintenance',
      };
    }
  }

  return { isMaintenanceStatus, signal: lifecycleSignal, displayStatusText, update };
}
