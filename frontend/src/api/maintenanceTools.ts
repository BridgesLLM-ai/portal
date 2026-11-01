import client from './client';

/** Updater v2 status (`GET /api/system/maintenance/tools`, DESIGN g.1). */

export type ToolStatusValue =
  | 'ok' | 'update-available' | 'below-floor' | 'drifted-requalifying' | 'drifted-failed' | 'degraded'
  | 'blocked' | 'updating' | 'failed-last-run' | 'recovery-required' | 'unknown-retrying' | 'not-installed'
  | 'not-checked' | 'needs-portal-release';

export type ToolCardAction = 'update-recommended' | 'update-newest' | 'requalify' | 'install' | 'review-plugin-consent' | 'repair';

export type ToolsRunAction = 'preflight' | 'update' | 'requalify' | 'install' | 'recover-native' | 'retry-checks';

export type ToolRefusal = { id: string; check: string | null; message: string; nextAction: string | null };

/** OpenClaw's Portal feature checks from the run's `result.contract` (c.4). */
export type ToolRunContract = {
  /** Optional feature -> the gateway methods it needs that OpenClaw doesn't offer. */
  featuresOff: Record<string, string[]>;
  /** Required gateway methods OpenClaw doesn't offer (a degraded result). */
  missingMethods: string[];
  /** passed/failed: the method list was checked; not-run: it wasn't, with toolctl's reason. */
  methods: { state: 'passed' | 'failed' | 'not-run'; reason: string | null };
};

export type ToolLastRun = {
  runId: string;
  action: string | null;
  state: string;
  startedAt: string | null;
  endedAt: string | null;
  errorId: string | null;
  message: string | null;
  nextAction: string | null;
  from: string | null;
  to: string | null;
  refusals: ToolRefusal[];
  contract?: ToolRunContract | null;
  /** OpenClaw: Portal plugins the run installed before its own update stopped; then never "Nothing was changed" (N4). */
  pluginsInstalled?: string[];
};

export type ToolStatusItem = {
  id: string;
  label: string;
  category: 'core' | 'cli' | 'harness' | 'runtime';
  installed: {
    version: string | null;
    admittedAt: string | null;
    admission: 'proven' | 'verified' | 'requalified' | 'unverified' | 'none';
    source: string | null;
    /** Admission record `source.authority`, e.g. probes-only, vendor-self-update, github-tag-commit. */
    authority?: string | null;
    /** Admission record `source.bytesVerified`; false = re-checked without comparing the bytes to a download. */
    bytesVerified?: boolean | null;
  };
  newest: { version: string | null; checkedAt: string | null; channel?: string };
  recommended: { version: string | null; proven: boolean };
  floor: string;
  status: ToolStatusValue;
  statusReason: string;
  capabilities: { required: { passed: string[]; failed: string[] }; optionalOff: string[] };
  restartsGateway: boolean;
  actions: ToolCardAction[];
  runActions: ToolsRunAction[];
  /** A missing tool this Portal can install: the version Install installs (the recommended one); otherwise null. */
  installVersion?: string | null;
  newerThanTested: boolean;
  /** This release updates the tool only to its recommended (qualified) version: no "Update to newest" (5.2.0). */
  newestNotOffered?: boolean;
  /** The policy holds this tool's update for a later Portal release (OpenClaw core, 5.2.0): nothing here updates it. */
  heldForLaterRelease?: boolean;
  lastGoodAt: string | null;
  lastRun?: ToolLastRun | null;
  /** OpenClaw: PF-8 disk lines from the latest pre-flight that recorded them; null/absent otherwise. */
  diskCheck?: { messages: string[]; checkedAt: string | null } | null;
  /** OpenClaw: how the latest pre-flight says the update runs; null/absent when no pre-flight recorded it. */
  updateMode?: ToolUpdateMode | null;
  /** OpenClaw: when the latest pre-flight of the installed version passed; null/absent when it did not, or none ran. */
  preflightPassedAt?: string | null;
};

/**
 * How an OpenClaw update runs (K7, backend `ToolStatusItem.updateMode`): `live` keeps chat up until OpenClaw switches
 * over; `stopped` stops the gateway for the whole update (`reason`: service-inspection | no-replacement-watcher).
 */
export type ToolUpdateMode = { mode: 'live' | 'stopped'; reason: string | null; checkedAt: string | null };

export type ToolRunStep = {
  id: string;
  label: string;
  state: string;
  startedAt: string | null;
  endedAt: string | null;
  detail: string | null;
  evidence: string[];
};

export type ToolsRecovery = {
  kind: 'legacy-ledger' | 'native-pending' | 'tools-run-interrupted';
  title: string;
  detail: string;
  action: { id: string; label: string };
  runId?: string;
  /** The tool whose run the action starts (`recover-native`, `requalify`); absent when the action is not a tool run. */
  tool?: string;
};

export type ToolsHistoryEntry = {
  runId: string;
  tool: string;
  action: string | null;
  from: string | null;
  to: string | null;
  outcome: string;
  errorId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  /** User id that requested the run; null for runs the Portal did not request. */
  initiator: string | null;
};

export type ToolsRunReport = {
  run: {
    runId: string;
    tool: string;
    state: string;
    phase: string;
    steps: ToolRunStep[];
    error?: { id?: string; message?: string; nextAction?: string | null } | null;
  };
  evidence: string[];
};

export type ToolsActiveRun = {
  runId: string;
  tool: string;
  phase: string;
  state: string;
  startedAt: string | null;
  steps: ToolRunStep[];
  nativePhase?: string | null;
  gatewayRestarting?: boolean;
  stale: boolean;
  /** What the run does once the runner recorded it (`install` reads as an installation); null/absent before. */
  action?: string | null;
  /** Why Stop is unavailable right now (plain sentence); null/absent when a stop may be requested. */
  stopRefusal?: string | null;
};

export type ToolsStatus = {
  schema: 'bridgesllm.tools.status.v1';
  generatedAt: string;
  policy: { valid: boolean; revision: number | null; sha256: string | null; error: string | null; defaultChannel: string | null; channels: string[] };
  runner: { installed: boolean; reason: string | null };
  recovery: ToolsRecovery | null;
  activeRun: ToolsActiveRun | null;
  tools: ToolStatusItem[];
  summary: { status: 'ok' | 'attention' | 'blocked' | 'recovery-required'; text: string; counts: Record<string, number> };
  history: ToolsHistoryEntry[];
};

export type ToolsRunBody = {
  tool: string;
  action: ToolsRunAction;
  target?: 'recommended' | 'newest';
  channel?: string | null;
  confirmation?: string;
  confirmed?: boolean;
  maintenanceWindowAcknowledged?: boolean;
  acknowledgements?: { nodeRuntime?: boolean };
};

export type ToolsRunAccepted = { runId: string };

export const maintenanceToolsAPI = {
  getStatus: async (force = false): Promise<ToolsStatus> => {
    const { data } = await client.get<ToolsStatus>('/system/maintenance/tools', {
      params: force ? { refresh: true } : undefined,
      _silent: true,
    } as any);
    return data;
  },

  getRunReport: async (runId: string): Promise<ToolsRunReport> => {
    const { data } = await client.get<ToolsRunReport>(`/system/maintenance/tools/runs/${encodeURIComponent(runId)}`);
    return data;
  },

  stopRun: async (runId: string): Promise<{ runId: string; stopping: true }> => {
    const { data } = await client.post<{ runId: string; stopping: true }>(`/system/maintenance/tools/runs/${encodeURIComponent(runId)}/stop`);
    return data;
  },

  startRun: async (body: ToolsRunBody): Promise<ToolsRunAccepted> => {
    const { data } = await client.post<ToolsRunAccepted>('/system/maintenance/tools/run', body);
    return data;
  },

  /** "Check interrupted update": starts toolctl reconcile for a run whose runner is gone (owner-only). */
  startReconcile: async (): Promise<{ started: true; runId: string | null }> => {
    const { data } = await client.post<{ started: true; runId: string | null }>('/system/maintenance/tools/reconcile');
    return data;
  },
};
