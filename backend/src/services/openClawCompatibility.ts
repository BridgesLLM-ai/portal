/** Exact source-supported contracts; hello methods, not a broad 9.x guess, enable controls. */
export const OPENCLAW_SOURCE_SUPPORTED_VERSIONS = Object.freeze([
  '2026.7.1', '2026.7.1-2', '2026.9.1', '2026.9.2', '2026.9.3', '2026.9.6', '2026.9.9', '2026.10.5', '2026.10.6',
]);
export interface OpenClawCapabilities {
  version: string | null;
  supported: boolean;
  incrementalChat: boolean;
  methods: readonly string[];
  goals: boolean;
  progress: boolean;
}
export function capabilitiesFromHello(hello: any): OpenClawCapabilities {
  const version = typeof hello?.server?.version === 'string' ? hello.server.version : null;
  const supported = version !== null && OPENCLAW_SOURCE_SUPPORTED_VERSIONS.includes(version);
  const methods: string[] = Array.isArray(hello?.features?.methods)
    ? [...new Set<string>(hello.features.methods.filter((method: unknown): method is string => typeof method === 'string'))]
    : [];
  return Object.freeze({ version, supported, incrementalChat: version === '2026.9.9' || version === '2026.10.5' || version === '2026.10.6', methods: Object.freeze(methods),
    goals: supported && methods.includes('sessions.goal.update') && methods.includes('sessions.goal.clear'),
    progress: supported && methods.includes('progressCard.get'),
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

/** Exact Canvas source contracts qualified by Portal, never a version-range guess. */
export function supportsOpenClawInlineWidgets(version: unknown): boolean {
  return version === '2026.9.9' || version === '2026.10.5' || version === '2026.10.6';
}
