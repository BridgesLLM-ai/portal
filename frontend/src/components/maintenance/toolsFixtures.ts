import type { ToolLastRun, ToolRunStep, ToolStatusItem, ToolsActiveRun, ToolsStatus } from '../../api/maintenanceTools';

/** Test fixtures for the AI tools panel (shapes of GET /api/system/maintenance/tools). */
export function toolItem(overrides: Partial<ToolStatusItem> = {}): ToolStatusItem {
  return {
    id: 'codex',
    label: 'Codex CLI',
    category: 'cli',
    installed: { version: '0.166.0', admittedAt: null, admission: 'verified', source: 'admission-record' },
    newest: { version: null, checkedAt: null },
    recommended: { version: '0.166.0', proven: false },
    floor: '0.163.0',
    status: 'ok',
    statusReason: 'Up to date.',
    capabilities: { required: { passed: [], failed: [] }, optionalOff: [] },
    restartsGateway: false,
    actions: ['update-newest'],
    runActions: ['update', 'requalify'],
    newerThanTested: false,
    lastGoodAt: null,
    lastRun: null,
    ...overrides,
  };
}

export function openclawItem(overrides: Partial<ToolStatusItem> = {}): ToolStatusItem {
  return toolItem({
    id: 'openclaw',
    label: 'OpenClaw',
    category: 'core',
    installed: { version: '2026.9.9', admittedAt: null, admission: 'none', source: 'package-json' },
    recommended: { version: '2026.10.9', proven: false },
    floor: '2026.9.9',
    status: 'update-available',
    statusReason: '2026.10.9 is recommended (not yet qualified).',
    restartsGateway: true,
    actions: ['update-recommended', 'update-newest'],
    runActions: ['preflight', 'update', 'retry-checks'],
    // A pre-flight passed just now (N2: the review opens only after a fresh one).
    preflightPassedAt: new Date().toISOString(),
    ...overrides,
  });
}

/** A launcher that exists but whose version nothing has read yet (backend read state `present`). */
export function notCheckedItem(overrides: Partial<ToolStatusItem> = {}): ToolStatusItem {
  return toolItem({
    id: 'grok-build',
    label: 'Grok Build',
    category: 'harness',
    installed: { version: null, admittedAt: null, admission: 'none', source: null },
    recommended: { version: '1.0.62', proven: false },
    floor: '1.0.62',
    status: 'not-checked',
    statusReason: 'Installed; not checked yet. Re-check Grok Build to confirm its version.',
    actions: ['requalify'],
    runActions: ['requalify'],
    ...overrides,
  });
}

/** A missing tool this Portal can install (backend read state `absent`, Install offered). */
export function missingItem(overrides: Partial<ToolStatusItem> = {}): ToolStatusItem {
  return toolItem({
    installed: { version: null, admittedAt: null, admission: 'none', source: null },
    status: 'not-installed',
    statusReason: 'Not installed on this server.',
    actions: ['install'],
    runActions: ['install'],
    installVersion: '0.166.0',
    ...overrides,
  });
}

export function toolsStatus(overrides: Partial<ToolsStatus> = {}): ToolsStatus {
  return {
    schema: 'bridgesllm.tools.status.v1',
    generatedAt: '2026-10-30T12:00:00.000Z',
    policy: { valid: true, revision: 1, sha256: null, error: null, defaultChannel: 'stable', channels: ['stable', 'extended-stable'] },
    runner: { installed: true, reason: null },
    recovery: null,
    activeRun: null,
    tools: [openclawItem(), toolItem()],
    summary: { status: 'attention', text: 'Updates are available for OpenClaw.', counts: {} },
    history: [],
    ...overrides,
  };
}

export function runStep(overrides: Partial<ToolRunStep> = {}): ToolRunStep {
  return { id: 'probe', label: 'Checking the installed CLI', state: 'passed', startedAt: null, endedAt: null, detail: null, evidence: [], ...overrides };
}

/** A run in progress as `activeRun` reports it (toolctl sets `phase` to the current step for tool runs). */
export function activeRun(overrides: Partial<ToolsActiveRun> = {}): ToolsActiveRun {
  return {
    runId: '0b6c2f1e-4a59-4d38-9d0e-2a7f5c1b9e01',
    tool: 'codex',
    phase: 'probe',
    state: 'running',
    startedAt: '2026-10-30T11:59:00.000Z',
    steps: [],
    nativePhase: null,
    gatewayRestarting: false,
    stale: false,
    ...overrides,
  };
}

/** A finished run as `tools[].lastRun` reports it. */
export function lastRun(overrides: Partial<ToolLastRun> = {}): ToolLastRun {
  return {
    runId: '0b6c2f1e-4a59-4d38-9d0e-2a7f5c1b9e02',
    action: 'update',
    state: 'succeeded',
    startedAt: '2026-10-30T11:00:00.000Z',
    endedAt: '2026-10-30T11:20:00.000Z',
    errorId: null,
    message: null,
    nextAction: null,
    from: '2026.9.9',
    to: '2026.10.9',
    refusals: [],
    contract: null,
    ...overrides,
  };
}
