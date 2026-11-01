import {
  isLegacyOpenClawVersion,
  OPENCLAW_FEATURE_FLOORS,
  OPENCLAW_RUNTIME_FLOOR,
  openClawCurrentFamilyAdmits,
  openClawReleaseDenial,
  openClawVersionMeetsFloor,
} from './openClawRuntimeContract';

/**
 * What the authenticated hello proves. `supported` is the retained 2026.7.1
 * tuple or the current family at or above the floor; each optional feature is
 * then gated on its own methods and says why it is off.
 */
export interface OpenClawCapabilities {
  version: string | null;
  supported: boolean;
  protocol: number | null;
  methods: readonly string[];
  events: readonly string[];
  goals: boolean;
  progress: boolean;
  inlineWidgets: boolean;
  /** Live (pinned) widgets: inline widgets plus the session board (`board.get`) for the newest version. */
  liveWidgets: boolean;
  /** Reason per optional feature that is off: `goals`, `progress`, `inlineWidgets`, `liveWidgets`. */
  disabledReasons: Readonly<Partial<Record<'goals' | 'progress' | 'inlineWidgets' | 'liveWidgets', string>>>;
}

function uniqueStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set<string>(value.filter((entry: unknown): entry is string => typeof entry === 'string'))]
    : [];
}

function unsupportedReason(version: string | null): string {
  if (!version) return 'OpenClaw is not connected.';
  const denial = openClawReleaseDenial(version);
  if (denial) return `OpenClaw ${version} is refused by the Portal: ${denial}`;
  if (!openClawVersionMeetsFloor(version)) return `OpenClaw ${version} is older than the supported floor ${OPENCLAW_RUNTIME_FLOOR}. Update OpenClaw.`;
  return `OpenClaw ${version} is not admitted while strict tested-release mode is on.`;
}

export function capabilitiesFromHello(hello: any): OpenClawCapabilities {
  const version = typeof hello?.server?.version === 'string' && hello.server.version.trim()
    ? hello.server.version.trim()
    : null;
  const supported = version !== null && (isLegacyOpenClawVersion(version) || openClawCurrentFamilyAdmits(version));
  const methods = uniqueStrings(hello?.features?.methods);
  const events = uniqueStrings(hello?.features?.events);
  const protocol = typeof hello?.protocol === 'number' && Number.isInteger(hello.protocol) ? hello.protocol : null;
  const missing = (required: readonly string[]) => required.filter((method) => !methods.includes(method));
  const gate = (required: readonly string[], featureFloor?: string): string | null => {
    if (!supported) return unsupportedReason(version);
    if (featureFloor && !openClawVersionMeetsFloor(version, featureFloor)) {
      return `OpenClaw ${version} predates the qualified contract for this feature (${featureFloor} or newer).`;
    }
    const absent = missing(required);
    return absent.length ? `The OpenClaw Gateway does not expose ${absent.join(', ')}.` : null;
  };
  const goalsReason = gate(['sessions.goal.update', 'sessions.goal.clear']);
  const progressReason = gate(['progressCard.get']);
  const inlineWidgetsReason = gate(['canvas.document.view'], OPENCLAW_FEATURE_FLOORS.inlineWidgets);
  const liveWidgetsReason = inlineWidgetsReason ?? gate(['board.get']);
  const disabledReasons: OpenClawCapabilities['disabledReasons'] = Object.freeze({
    ...(goalsReason ? { goals: goalsReason } : {}),
    ...(progressReason ? { progress: progressReason } : {}),
    ...(inlineWidgetsReason ? { inlineWidgets: inlineWidgetsReason } : {}),
    ...(liveWidgetsReason ? { liveWidgets: liveWidgetsReason } : {}),
  });
  return Object.freeze({
    version,
    supported,
    protocol,
    methods: Object.freeze(methods),
    events: Object.freeze(events),
    goals: goalsReason === null,
    progress: progressReason === null,
    inlineWidgets: inlineWidgetsReason === null,
    liveWidgets: liveWidgetsReason === null,
    disabledReasons,
  });
}
let current = capabilitiesFromHello(null);
export function observeOpenClawHello(hello: unknown): void { current = capabilitiesFromHello(hello); }
export function clearOpenClawHello(): void { current = capabilitiesFromHello(null); }
export function getOpenClawCapabilities(): OpenClawCapabilities { return current; }

/** Per-run/per-lane sequence fence. Transport ordering is required; gaps trigger resnapshot. */
export class GatewayFrameFence {
  private last = new Map<string, number>();
  accept(event: string, payload: any): 'accept' | 'duplicate' | 'gap' {
    if (!payload || !Number.isSafeInteger(payload.seq) || payload.seq < 0 || !payload.runId) return 'accept';
    const key = `${event}:${payload.sessionKey || ''}:${payload.runId}:${event === 'agent' || event === 'session.tool' ? payload.stream || '' : ''}`;
    const previous = this.last.get(key);
    if (previous !== undefined && payload.seq <= previous) return 'duplicate';
    this.last.delete(key);
    this.last.set(key, payload.seq);
    while (this.last.size > 2048) this.last.delete(this.last.keys().next().value!);
    // Agent seq is shared across stream lanes, so lane skips are not proof of loss.
    return 'accept';
  }
  clear(): void { this.last.clear(); }
}

/** 9.7+ sends deltaText/replace; 9.6 and earlier send cumulative message.content. */
export function assembleChatSnapshot(previous: string, payload: any, legacySnapshot: string): string {
  if (typeof payload?.deltaText === 'string') {
    return payload.replace === true ? payload.deltaText : previous + payload.deltaText;
  }
  return legacySnapshot;
}

/** Inline widgets: supported runtime, qualified Canvas contract, `canvas.document.view` in the hello. */
export function supportsOpenClawInlineWidgets(caps: Pick<OpenClawCapabilities, 'inlineWidgets'> | null | undefined): boolean {
  return caps?.inlineWidgets === true;
}
