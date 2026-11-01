import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  LEGACY_ROOT_IDS,
  SYSTEMD_TOOLS_RUN_STOP_ARGS,
  ToolsStatusService,
  buildToolsStatus,
  compareVersions,
  computeToolsSummary,
  legacyRootPaths,
  markToolsRunLaunchFailed,
  readToolsSnapshot,
  writeToolsRunRequest,
  type ToolPolicy,
  type ToolStatusItem,
  type ToolsPaths,
  type ToolsRecovery,
  type ToolsRunRequest,
  type ToolsSnapshot,
} from '../services/toolsStatus';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const POLICY_PATH = path.join(REPO_ROOT, 'installer/tools/tool-policy.v2.json');
const TOOLCTL_PATH = path.join(REPO_ROOT, 'installer/tools/bridgesllm-toolctl.py');
const RUN_ID = '0b6c2f1e-4a59-4d38-9d0e-2a7f5c1b9e01';

/** The shipped policy with the OpenClaw core update on: 5.2.0 holds it (openclaw.coreUpdates) and the K7 flow stays
 *  behind that flag, so these tests keep covering it; the flag's own tests below set it. */
function policy(): ToolPolicy {
  const value = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
  delete value.openclaw.coreUpdates;
  return value;
}

function snapshot(overrides: Partial<ToolsSnapshot> = {}): ToolsSnapshot {
  const base: ToolsSnapshot = {
    generatedAtMs: Date.parse('2026-10-30T12:00:00Z'),
    policy: policy(),
    policySha256: 'a'.repeat(64),
    policyError: null,
    legacyOpen: [],
    runs: [],
    lockOwner: null,
    history: [],
    installed: {
      openclaw: { version: '2026.9.9', admittedAt: null, admission: 'none', source: 'package-json' },
      codex: { version: '0.166.0', admittedAt: null, admission: 'none', source: 'package-json' },
    },
    runner: { installed: true, reason: null },
    bootId: 'boot-1',
  };
  return { ...base, ...overrides };
}

/** The shipped policy with the recommended version of `ids` qualified (npm: its SRI; others: both machines). */
function qualifiedPolicy(...ids: string[]): ToolPolicy {
  const value = policy();
  for (const tool of value.tools) {
    if (!ids.includes(tool.id)) continue;
    const integrity = tool.source.kind === 'npm'
      ? `sha512-${'A'.repeat(86)}==`
      : tool.source.kind === 'github-tarball'
        ? `sha256-tree:${'c'.repeat(64)}`
        : { x86_64: `sha256:${'a'.repeat(64)}`, aarch64: `sha256:${'b'.repeat(64)}` };
    Object.assign(tool.newestProven as any, { status: 'qualified', integrity, qualifiedAt: '2026-11-02T10:00:00Z' });
  }
  return value;
}

/** An all-proposed copy of the shipped policy (as installer/tools/tests/tool_policy_fixture.py makes it) with only the
 *  recommended version of `ids` qualified: for tests whose subject is which versions are qualified. */
function qualifiedOnlyPolicy(...ids: string[]): ToolPolicy {
  const value = qualifiedPolicy(...ids);
  for (const tool of value.tools) {
    if (!ids.includes(tool.id)) Object.assign(tool.newestProven as any, { status: 'proposed', integrity: null, qualifiedAt: null });
  }
  return value;
}

function run(state: string, phase = state, extra: Record<string, unknown> = {}) {
  return {
    schema: 'bridgesllm.tools.run.v1', runId: RUN_ID, tool: 'openclaw', phase, phaseStartedAt: null, state,
    createdAt: '2026-10-30T11:59:00.000Z', steps: [], error: null, result: null, ...extra,
  };
}

describe('tools status model', () => {
  test('a host below the recommended version gets one update item and an attention summary', () => {
    const status = buildToolsStatus(snapshot());
    const openclaw = status.tools.find((tool) => tool.id === 'openclaw')!;
    expect(openclaw).toMatchObject({
      status: 'update-available',
      recommended: { version: '2026.10.9', proven: false },
      floor: '2026.9.1',
      restartsGateway: true,
      actions: ['update-recommended', 'update-newest'],
    });
    expect(openclaw.statusReason).toContain('not yet qualified');
    // Codex is at its recommended version: nothing recommended, the newest stays a choice, and a Re-check (N6).
    expect(status.tools.find((tool) => tool.id === 'codex')).toMatchObject({
      status: 'ok', actions: ['update-newest', 'requalify'], runActions: ['update', 'requalify'],
    });
    expect(openclaw.runActions).toEqual(['preflight', 'update', 'retry-checks']);
    // Tools outside the wave-3 run contract are reported, never offered.
    expect(status.tools.find((tool) => tool.id === 'hermes')).toMatchObject({ status: 'unknown-retrying', actions: [], runActions: [] });
    // OpenCode is runnable in this build, but with no version read nothing is offered yet.
    expect(status.tools.find((tool) => tool.id === 'opencode')).toMatchObject({ status: 'unknown-retrying', actions: [], runActions: [] });
    expect(status.summary.status).toBe('attention');
    expect(status.summary.text).toContain('Updates are available for OpenClaw.');
    expect(status.recovery).toBeNull();
    expect(status.activeRun).toBeNull();
  });

  test('an open legacy ledger offers only the matching recovery action (P7)', () => {
    const status = buildToolsStatus(snapshot({
      legacyOpen: [{ id: 'gateway-authorization-fence', path: '/var/lib/bridgesllm/openclaw-gateway-authorization-fence.v1' }],
    }));
    expect(status.recovery).toMatchObject({
      kind: 'legacy-ledger',
      action: { id: 'recover-legacy', label: 'Recover interrupted maintenance' },
      roots: ['gateway-authorization-fence'],
    });
    // Text only this release, but it says exactly what to run and where.
    expect(status.recovery!.detail).toContain('as root, from the directory that contains install.sh, run: sudo bash install.sh --recover');
    expect(status.recovery!.detail).toMatch(/docs\/INSTALLER_RECOVERY\.md\)\. Then choose Check AI tools again\.$/);
    expect(status.recovery).not.toHaveProperty('tool');
    expect(status.tools.flatMap((tool) => tool.runActions)).toEqual([]);
    expect(status.tools.every((tool) => tool.status === 'recovery-required' && tool.actions.length === 0)).toBe(true);
    expect(status.summary.status).toBe('recovery-required');
  });

  test('a live run shows progress and no update actions; a dead runner becomes recovery', () => {
    const live = buildToolsStatus(snapshot({
      runs: [run('preflight') as any],
      lockOwner: { runId: RUN_ID, pid: 4242, bootId: 'boot-1' },
    }), { processAlive: () => true });
    expect(live.activeRun).toMatchObject({ runId: RUN_ID, state: 'preflight', stale: false, nativePhase: null });
    const updating = buildToolsStatus(snapshot({
      runs: [{ ...run('native'), state: 'running', native: { phase: 'validating' } } as any],
      lockOwner: { runId: RUN_ID, pid: 4242, bootId: 'boot-1' },
    }), { processAlive: () => true });
    expect(updating.activeRun).toMatchObject({ phase: 'native', nativePhase: 'validating' });
    const odd = buildToolsStatus(snapshot({
      runs: [{ ...run('native'), state: 'running', native: { phase: '<script>' } } as any],
      lockOwner: { runId: RUN_ID, pid: 4242, bootId: 'boot-1' },
    }), { processAlive: () => true });
    expect(odd.activeRun?.nativePhase).toBeNull();
    expect(live.recovery).toBeNull();
    expect(live.tools.find((tool) => tool.id === 'openclaw')).toMatchObject({ status: 'updating', actions: [] });
    expect(live.tools.flatMap((tool) => tool.actions)).toEqual([]);
    expect(live.summary).toMatchObject({ status: 'attention', text: 'OpenClaw is updating.' });

    const dead = buildToolsStatus(snapshot({
      runs: [run('running', 'native') as any],
      lockOwner: { runId: RUN_ID, pid: 4242, bootId: 'boot-1' },
    }), { processAlive: () => false });
    expect(dead.recovery).toMatchObject({ kind: 'tools-run-interrupted', action: { id: 'reconcile-tools-run' }, runId: RUN_ID });
    expect(dead.summary.status).toBe('recovery-required');

    const rebooted = buildToolsStatus(snapshot({
      runs: [run('running', 'native') as any],
      lockOwner: { runId: RUN_ID, pid: 4242, bootId: 'boot-0' },
    }), { processAlive: () => true });
    expect(rebooted.recovery?.kind).toBe('tools-run-interrupted');

    // A queued run that has not started yet is not "interrupted".
    const queued = buildToolsStatus(snapshot({ runs: [run('queued') as any] }), { processAlive: () => false });
    expect(queued.recovery).toBeNull();
    expect(queued.activeRun).toMatchObject({ state: 'queued', stale: false });
  });

  test('a queued run whose unit never started stops blocking after 10 minutes', () => {
    const at = (iso: string) => snapshot({ generatedAtMs: Date.parse(iso), runs: [run('queued') as any] });
    expect(buildToolsStatus(at('2026-10-30T12:08:59Z')).activeRun).toMatchObject({ state: 'queued' });
    const stale = buildToolsStatus(at('2026-10-30T12:09:00Z'));
    expect(stale.activeRun).toBeNull();
    expect(stale.recovery).toBeNull();
    expect(stale.tools.find((tool) => tool.id === 'openclaw')!.actions).toContain('update-recommended');
    // A queued run that holds the lock is starting, not stale.
    const starting = buildToolsStatus(snapshot({
      generatedAtMs: Date.parse('2026-10-30T13:00:00Z'), runs: [run('queued') as any],
      lockOwner: { runId: RUN_ID, pid: 1, bootId: 'boot-1' },
    }), { processAlive: () => true });
    expect(starting.activeRun).toMatchObject({ state: 'queued' });
  });

  test('a run that ended in recovery-required keeps recovery visible', () => {
    const status = buildToolsStatus(snapshot({
      runs: [run('recovery-required', 'recovery-required', { error: { id: 'TOOLS_RUN_INTERRUPTED', message: 'Interrupted.' } }) as any],
    }));
    expect(status.recovery).toMatchObject({ kind: 'tools-run-interrupted', action: { id: 'recover-native' }, detail: 'Interrupted.' });
    expect(status.tools.flatMap((tool) => tool.actions)).toEqual([]);
  });

  test('OpenClaw running again after a refused rollback offers only Retry checks', () => {
    const message = 'OpenClaw 2026.10.9 is running again, but its checks failed (OC-CONFIG); the Portal could not return to '
      + '2026.9.9: The previous version can\'t read the migrated state.';
    const status = buildToolsStatus(snapshot({
      runs: [run('recovery-required', 'recovery-required', {
        error: { id: 'ROLLBACK_REFUSED', message, nextAction: 'retry-checks' },
      }) as any],
    }));
    expect(status.recovery).toMatchObject({
      kind: 'tools-run-interrupted', title: 'OpenClaw is running, but its Portal checks did not pass.', detail: message,
      action: { id: 'retry-checks', label: 'Retry checks' }, tool: 'openclaw',
    });
    const openclaw = status.tools.find((tool) => tool.id === 'openclaw')!;
    expect(openclaw).toMatchObject({ status: 'recovery-required', runActions: ['retry-checks'] });
    expect(status.tools.filter((tool) => tool.id !== 'openclaw').flatMap((tool) => tool.runActions)).toEqual([]);
    expect(status.tools.flatMap((tool) => tool.actions)).toEqual([]);
    expect(status.summary.text).toBe('OpenClaw is running, but its Portal checks did not pass. Retry checks to continue.');
    // Any other OpenClaw recovery-required run keeps OpenClaw repair as its one action.
    const parked = buildToolsStatus(snapshot({
      runs: [run('recovery-required', 'recovery-required', {
        error: { id: 'ROLLBACK_REFUSED', message: 'Stopped.', nextAction: 'recover-native' },
      }) as any],
    }));
    expect(parked.recovery).toMatchObject({ action: { id: 'recover-native' } });
    expect(parked.tools.find((tool) => tool.id === 'openclaw')!.runActions).toEqual(['recover-native']);
  });

  test('below floor and denylisted versions block; a failed last run asks for attention', () => {
    const below = buildToolsStatus(snapshot({
      installed: { openclaw: { version: '2026.8.30', admittedAt: null, admission: 'none', source: 'package-json' } },
    }));
    expect(below.tools.find((tool) => tool.id === 'openclaw')).toMatchObject({
      status: 'below-floor', actions: ['update-recommended', 'update-newest'],
    });
    expect(below.summary).toMatchObject({ status: 'blocked', text: 'OpenClaw needs an update before it can be used.' });

    const denied = policy();
    denied.tools.find((tool) => tool.id === 'openclaw')!.denylist = [{ version: '2026.10.6', reason: 'breaks chat' }];
    const blocked = buildToolsStatus(snapshot({
      policy: denied,
      installed: { openclaw: { version: '2026.10.6', admittedAt: null, admission: 'none', source: 'package-json' } },
    }));
    expect(blocked.tools.find((tool) => tool.id === 'openclaw')).toMatchObject({
      status: 'blocked', statusReason: 'OpenClaw 2026.10.6 is blocked: breaks chat',
    });

    const failed = buildToolsStatus(snapshot({
      installed: { openclaw: { version: '2026.10.9', admittedAt: null, admission: 'none', source: 'package-json' } },
      runs: [run('failed', 'failed', { error: { id: 'NATIVE_EXECUTION_UNAVAILABLE', message: 'Nothing was changed.' } }) as any],
    }));
    expect(failed.tools.find((tool) => tool.id === 'openclaw')).toMatchObject({
      status: 'failed-last-run', statusReason: 'Nothing was changed.', lastRun: { errorId: 'NATIVE_EXECUTION_UNAVAILABLE' },
    });
  });

  test('an unreadable installed version is unknown-retrying, never blocked (F2)', () => {
    const status = buildToolsStatus(snapshot({
      installed: { openclaw: { version: null, admittedAt: null, admission: 'none', source: null } },
    }));
    expect(status.tools.find((tool) => tool.id === 'openclaw')).toMatchObject({ status: 'unknown-retrying', actions: [] });
    expect(status.summary.status).toBe('attention');
  });

  test('a missing package is "not installed"; only the core being missing blocks', () => {
    const cli = buildToolsStatus(snapshot({
      installed: {
        openclaw: { version: '2026.10.9', admittedAt: null, admission: 'none', source: 'package-json' },
        codex: { version: null, admittedAt: null, admission: 'none', source: null },
      },
      installedReads: { openclaw: 'ok', codex: 'absent' },
    }));
    // Missing, not broken: its only action is Install (5.2.0).
    expect(cli.tools.find((tool) => tool.id === 'codex')).toMatchObject({
      status: 'not-installed', statusReason: 'Not installed on this server.', actions: ['install'],
    });
    expect(cli.summary.status).not.toBe('blocked');
    const core = buildToolsStatus(snapshot({
      installed: { openclaw: { version: null, admittedAt: null, admission: 'none', source: null } },
      installedReads: { openclaw: 'absent' },
    }));
    expect(core.summary).toMatchObject({ status: 'blocked', text: 'OpenClaw is not installed on this server.' });
  });

  test('a missing installable tool is offered Install of the recommended version, qualified or not (as Update is)', () => {
    // Codex and Ollama qualified here; ClawHub is not (its update is offered all the same, and so is its install).
    const shipped = qualifiedOnlyPolicy('codex', 'ollama', 'agent-zero', 'opencode', 'openclaw');
    const ids = shipped.tools.map((tool) => tool.id);
    const openclawVersion = shipped.tools.find((tool) => tool.id === 'openclaw')!.newestProven.version;
    const missing = (overrides: Partial<ToolsSnapshot> = {}) => buildToolsStatus(snapshot({
      policy: shipped,
      installed: { openclaw: { version: openclawVersion, admittedAt: null, admission: 'none', source: 'package-json' } },
      installedReads: Object.fromEntries(ids.map((id) => [id, id === 'openclaw' ? 'ok' : 'absent'])) as any,
      ...overrides,
    }));
    const status = missing();
    const card = (id: string, from = status) => from.tools.find((tool) => tool.id === id)!;
    for (const id of ['codex', 'ollama', 'clawhub', 'opencode', 'hermes', 'grok-build', 'antigravity']) {
      expect(card(id)).toMatchObject({
        status: 'not-installed', statusReason: 'Not installed on this server.', actions: ['install'], runActions: ['install'],
        installVersion: shipped.tools.find((tool) => tool.id === id)!.newestProven.version,
      });
    }
    expect(card('clawhub').recommended.proven).toBe(false);
    // Agent Zero needs its Owner login file first ("Not configured."); OpenClaw is never installed from here.
    expect(card('agent-zero')).toMatchObject({ status: 'not-installed', statusReason: 'Not configured.' });
    for (const id of ['agent-zero', 'openclaw']) {
      expect([id, card(id).actions.includes('install'), card(id).installVersion, card(id).runActions.includes('install')])
        .toEqual([id, false, null, false]);
    }
    // A missing tool is not broken: nothing asks for attention because of it.
    expect(status.summary).toMatchObject({ status: 'ok', text: 'All installed AI tools are up to date.' });
    expect(status.summary.counts['not-installed']).toBe(ids.length - 1);
    // A failed read is never "missing".
    const unreadable = missing({ installedReads: { ...Object.fromEntries(ids.map((id) => [id, 'absent'])), openclaw: 'ok', codex: 'unreadable' } as any });
    expect(card('codex', unreadable)).toMatchObject({ actions: [], runActions: [], installVersion: null });
    // P7: an open recovery, or any run, offers no install.
    const recovering = missing({ runs: [{ ...run('recovery-required'), tool: 'clawhub', error: { id: 'TOOLS_RUN_INTERRUPTED', message: 'x' } } as any] });
    expect([card('codex', recovering).runActions, recovering.tools.flatMap((tool) => tool.actions)]).toEqual([[], []]);
    const busy = buildToolsStatus(snapshot({
      policy: shipped,
      installed: { openclaw: { version: openclawVersion, admittedAt: null, admission: 'none', source: 'package-json' } },
      installedReads: Object.fromEntries(ids.map((id) => [id, id === 'openclaw' ? 'ok' : 'absent'])) as any,
      runs: [{ ...run('running', 'swap'), tool: 'ollama', action: 'install' } as any],
      lockOwner: { runId: RUN_ID, pid: 4242, bootId: 'boot-1' },
    }), { processAlive: () => true });
    // The card keeps naming what Install would install; the action comes back when the run ends.
    expect(card('codex', busy)).toMatchObject({ actions: [], runActions: [], installVersion: card('codex').installVersion });
    expect(card('ollama', busy)).toMatchObject({ status: 'updating', statusReason: 'Installing Ollama…' });
    expect(busy.activeRun).toMatchObject({ tool: 'ollama', action: 'install' });
  });

  test('an install that needs its Re-check says installation, and the last run keeps the install action', () => {
    const interrupted = { ...run('recovery-required'), tool: 'codex', action: 'install', result: null,
      error: { id: 'INSTALL_REMOVE_FAILED', message: 'Codex was installed but failed its check.' } };
    const status = buildToolsStatus(snapshot({ runs: [interrupted as any], installedReads: { codex: 'present' } }));
    expect(status.recovery).toMatchObject({ title: 'The Codex CLI installation needs to be checked.', action: { id: 'requalify', label: 'Re-check Codex CLI' } });
    expect(status.tools.find((tool) => tool.id === 'codex')!.lastRun).toMatchObject({ action: 'install', errorId: 'INSTALL_REMOVE_FAILED' });
    const updated = buildToolsStatus(snapshot({ runs: [{ ...interrupted, action: 'update' } as any], installedReads: { codex: 'present' } }));
    expect(updated.recovery?.title).toBe('The Codex CLI update needs to be checked.');
  });

  test('a failed read during a run says "checking" with the last good result and its age (F2)', async () => {
    let read: 'ok' | 'unreadable' = 'ok';
    let now = Date.parse('2026-10-30T12:00:00Z');
    const service = new ToolsStatusService({
      nowMs: () => now,
      processAlive: () => true,
      readSnapshot: (_paths, nowMs) => snapshot({
        generatedAtMs: nowMs,
        installed: { openclaw: { version: read === 'ok' ? '2026.8.30' : null, admittedAt: null, admission: 'none', source: read === 'ok' ? 'package-json' : null } },
        installedReads: { openclaw: read },
      }),
    });
    expect((await service.get()).tools[0]).toMatchObject({ status: 'below-floor', lastGoodAt: null });
    read = 'unreadable';
    now += 3 * 60_000;
    const checking = (await service.get(true)).tools[0];
    expect(checking).toMatchObject({
      status: 'unknown-retrying', installed: { version: '2026.8.30' }, lastGoodAt: '2026-10-30T12:00:00.000Z', actions: [],
      statusReason: 'Checking again. Last confirmed 3 min ago.',
    });
    // Never a verdict from a failed read: no blocked/below-floor/update-available.
    expect(['blocked', 'below-floor', 'update-available']).not.toContain(checking.status);
  });

  test('during the OpenClaw restart window the core card says restarting and other failed reads say checking', () => {
    const status = buildToolsStatus(snapshot({
      runs: [{ ...run('native'), state: 'running', native: { phase: 'restarting' } } as any],
      lockOwner: { runId: RUN_ID, pid: 4242, bootId: 'boot-1' },
      installed: {
        openclaw: { version: null, admittedAt: null, admission: 'none', source: null },
        codex: { version: null, admittedAt: null, admission: 'none', source: null },
      },
      installedReads: { openclaw: 'unreadable', codex: 'unreadable' },
    }), { processAlive: () => true });
    expect(status.activeRun).toMatchObject({ nativePhase: 'restarting', gatewayRestarting: true });
    expect(status.tools.find((tool) => tool.id === 'openclaw')).toMatchObject({
      status: 'updating', statusReason: 'OpenClaw is restarting. Chats pause for a few minutes; this page keeps checking.',
    });
    expect(status.tools.find((tool) => tool.id === 'codex')).toMatchObject({
      status: 'unknown-retrying', statusReason: 'Checking… another update is running.', actions: [], runActions: [],
    });
    expect(status.summary).toMatchObject({ status: 'attention', text: 'OpenClaw is updating.' });
    const checks = buildToolsStatus(snapshot({
      runs: [{ ...run('contract'), state: 'verifying' } as any],
      lockOwner: { runId: RUN_ID, pid: 4242, bootId: 'boot-1' },
    }), { processAlive: () => true });
    expect(checks.activeRun?.gatewayRestarting).toBe(true);
  });

  test('a version newer than the tested one is ok and says so plainly', () => {
    const status = buildToolsStatus(snapshot({
      installed: { openclaw: { version: '2026.10.10', admittedAt: null, admission: 'none', source: 'package-json' } },
    }));
    expect(status.tools.find((tool) => tool.id === 'openclaw')).toMatchObject({
      status: 'ok', newerThanTested: true, actions: ['update-newest'],
      statusReason: 'Newer than tested: 2026.10.9 is the newest version this Portal has tested.',
    });
  });

  test('a tool that changed itself asks for a re-check first, and an update only after the re-check failed (b.5)', () => {
    const drift = { codex: { admittedVersion: '0.163.0', liveVersion: '0.166.0' } };
    const changed = buildToolsStatus(snapshot({ drift }));
    expect(changed.tools.find((tool) => tool.id === 'codex')).toMatchObject({
      status: 'drifted-requalifying', actions: ['requalify'],
      statusReason: 'Codex CLI changed itself (now 0.166.0, last checked 0.163.0). Re-check it before relying on it.',
    });
    expect(changed.summary.status).toBe('attention');
    // 0.166.0 is the recommended version: toolctl reinstalls it only when its re-check offered that (the
    // tree differs from its record); after any other failed re-check the update would be "already current".
    const failed = buildToolsStatus(snapshot({
      drift,
      runs: [{ ...run('refused'), tool: 'codex', result: { action: 'requalify' },
        error: { id: 'NPM_TREE_DIFFERS', message: 'The installed files differ from the official 0.166.0 release.',
          nextAction: 'update-recommended' } } as any],
    }));
    expect(failed.tools.find((tool) => tool.id === 'codex')).toMatchObject({
      status: 'drifted-failed', actions: ['requalify', 'update-recommended', 'update-newest'],
      lastRun: { action: 'requalify', state: 'refused', message: 'The installed files differ from the official 0.166.0 release.' },
    });
    const probeFailed = buildToolsStatus(snapshot({
      drift,
      runs: [{ ...run('refused'), tool: 'codex', result: { action: 'requalify' },
        error: { id: 'CLI_PROBE_FAILED', message: 'Codex CLI 0.166.0 failed its C-VER check.', nextAction: 'requalify' } } as any],
    }));
    expect(probeFailed.tools.find((tool) => tool.id === 'codex')).toMatchObject({
      status: 'drifted-failed', actions: ['requalify', 'update-newest'],
    });
  });

  test('5.2.0 offers "Update to newest" only for the npm CLIs; every other tool updates only to its qualified version', () => {
    const item = (id: string, version: string) => buildToolsStatus(snapshot({
      installed: { [id]: { version, admittedAt: '2026-10-30T11:00:00.000Z', admission: 'verified', source: 'admission-record' } },
    })).tools.find((tool) => tool.id === id)!;
    for (const id of ['codex', 'claude-code', 'clawhub']) {
      const card = item(id, '0.0.1');
      expect(card.actions).toEqual(['update-recommended', 'update-newest']);
      expect(card).not.toHaveProperty('newestNotOffered');
    }
    for (const id of ['opencode', 'hermes', 'grok-build', 'antigravity', 'ollama', 'agent-zero']) {
      const card = item(id, '0.0.1');
      expect(card).toMatchObject({ status: 'below-floor', newestNotOffered: true });
      expect(card.actions).not.toContain('update-newest');
    }
    // Not vacuous: the qualified update stays offered.
    for (const id of ['opencode', 'hermes', 'ollama']) expect(item(id, '0.0.1').actions).toEqual(['update-recommended']);
  });

  test('a current tool is offered its Re-check whenever the run endpoint accepts one (TEST N6)', () => {
    const item = (id: string, version: string) => buildToolsStatus(snapshot({
      installed: { [id]: { version, admittedAt: '2026-10-30T11:00:00.000Z', admission: 'verified', source: 'admission-record' } },
    })).tools.find((tool) => tool.id === id)!;
    // Up to date, or newer than tested: the Re-check (Codex keeps its "newest" choice; Antigravity has no "newest").
    expect(item('codex', '0.166.0')).toMatchObject({ status: 'ok', actions: ['update-newest', 'requalify'] });
    expect(item('clawhub', '0.24.1')).toMatchObject({ status: 'ok', actions: ['update-newest', 'requalify'] });
    expect(item('antigravity', '1.4.12')).toMatchObject({ status: 'ok', newerThanTested: true, actions: ['requalify'] });
    // OpenClaw has no Re-check run, so none is offered; below the floor the update is the way forward, not a Re-check.
    expect(item('openclaw', '2026.10.9').actions).not.toContain('requalify');
    expect(item('codex', '0.160.0')).toMatchObject({ status: 'below-floor', actions: ['update-recommended', 'update-newest'] });
  });

  test('an update to the installed version is offered only when toolctl admits it; otherwise the re-check', () => {
    const at = (version: string, error: Record<string, unknown> | null, state = 'refused', action = 'requalify') =>
      buildToolsStatus(snapshot({
        installed: { codex: { version, admittedAt: null, admission: 'none', source: 'package-json' } },
        runs: [{ ...run(state as any), tool: 'codex', result: { action }, error } as any],
      })).tools.find((tool) => tool.id === 'codex')!;
    // A failed update while the recommended version is installed: re-check, never a refused "update".
    expect(at('0.166.0', { id: 'NPM_SWAPPED_BACK', message: 'x', nextAction: null }, 'rolled-back', 'update').actions)
      .toEqual(['requalify', 'update-newest']);
    // The re-check found the tree differs from its record: toolctl reinstalls the same version.
    expect(at('0.166.0', { id: 'NPM_TREE_DIFFERS', message: 'x', nextAction: 'update-recommended' }).actions)
      .toEqual(['update-recommended', 'update-newest']);
    // The re-check's probe failed on the official files: reinstalling changes nothing, so re-check.
    expect(at('0.166.0', { id: 'CLI_PROBE_FAILED', message: 'x', nextAction: 'requalify' }).actions)
      .toEqual(['requalify', 'update-newest']);
    // Above the recommended version an update to it is a refused downgrade.
    expect(at('0.167.0', { id: 'NPM_SWAPPED_BACK', message: 'x', nextAction: null }, 'rolled-back', 'update').actions)
      .toEqual(['requalify', 'update-newest']);
    // Below it the update is a real one.
    expect(at('0.165.0', { id: 'NPM_SWAPPED_BACK', message: 'x', nextAction: null }, 'rolled-back', 'update').actions)
      .toEqual(['update-recommended', 'update-newest']);
  });

  test('the last run carries its refusal reasons and next actions for the result panel', () => {
    const status = buildToolsStatus(snapshot({
      runs: [run('refused', 'refused', {
        endedAt: '2026-10-30T11:59:40.000Z',
        result: { action: 'update', from: '2026.9.9', to: null },
        error: {
          id: 'PF8_DISK', message: 'Needs 49 GB free on /, has 19 GB.', nextAction: 'free-disk',
          refusals: [
            { id: 'PF8_DISK', check: 'PF-8', message: 'Needs 49 GB free on /, has 19 GB.', nextAction: null, detail: { big: 'x' } },
            { id: 'PF7_NODE', check: 'PF-7', message: 'Node.js 24.21.0 must be updated.', nextAction: 'node-runtime' },
            { id: 'BAD', check: 'PF-1', message: 42 },
          ],
        },
      }) as any],
    }));
    expect(status.tools.find((tool) => tool.id === 'openclaw')!.lastRun).toEqual({
      runId: RUN_ID, action: 'update', state: 'refused', startedAt: '2026-10-30T11:59:00.000Z', endedAt: '2026-10-30T11:59:40.000Z',
      errorId: 'PF8_DISK', message: 'Needs 49 GB free on /, has 19 GB.', nextAction: 'free-disk', from: '2026.9.9', to: null,
      refusals: [
        { id: 'PF8_DISK', check: 'PF-8', message: 'Needs 49 GB free on /, has 19 GB.', nextAction: null },
        { id: 'PF7_NODE', check: 'PF-7', message: 'Node.js 24.21.0 must be updated.', nextAction: 'node-runtime' },
      ],
      contract: null,
    });
  });

  test('an OpenClaw run\'s feature checks reach the card: features off, missing methods, gateway methods (bounded)', () => {
    const lastRun = (contract: unknown) => buildToolsStatus(snapshot({
      runs: [run('succeeded-degraded', 'succeeded-degraded', {
        result: { action: 'update', from: '2026.9.9', to: '2026.10.9', contract },
        error: { id: 'CONTRACT_REQUIRED_PROBE_FAILED', message: 'Chat is unavailable: OpenClaw doesn\'t offer chat.send.', nextAction: 'retry-checks' },
      }) as any],
    })).tools.find((tool) => tool.id === 'openclaw')!.lastRun!;
    expect(lastRun({
      passed: ['OC-CONFIG'], failed: ['OC-HELLO'], notRun: [], missingMethods: ['chat.send', '<b>x</b>', 7],
      featuresOff: { goals: ['sessions.goal.update', 'sessions.goal.clear'], steering: [], '<script>': ['x'], 'inline widgets': ['canvas.document.view'] },
      methods: { state: 'failed' },
    }).contract).toEqual({
      featuresOff: { goals: ['sessions.goal.update', 'sessions.goal.clear'], 'inline widgets': ['canvas.document.view'] },
      missingMethods: ['chat.send'],
      methods: { state: 'failed', reason: null },
    });
    const reason = 'The Portal backend hasn\'t reconnected to OpenClaw since this run\'s restart window opened, so OpenClaw\'s method list wasn\'t checked.';
    expect(lastRun({ passed: ['OC-HELLO'], failed: [], notRun: [], missingMethods: [], featuresOff: {}, methods: { state: 'not-run', reason } }).contract)
      .toEqual({ featuresOff: {}, missingMethods: [], methods: { state: 'not-run', reason } });
    // A record from before the method list existed was never checked; no contract at all reads as not reached.
    expect(lastRun({ passed: ['OC-HELLO'], failed: [], notRun: [] }).contract).toEqual({ featuresOff: {}, missingMethods: [], methods: { state: 'not-run', reason: null } });
    expect(lastRun(undefined).contract).toBeNull();
    expect(lastRun(['odd']).contract).toBeNull();
  });

  test('an update that finished succeeded-degraded is "Some features off", never "Up to date", until a later run succeeds', () => {
    // Only OpenClaw and Codex, both readable, so nothing else asks for attention.
    const twoTools = policy();
    twoTools.tools = twoTools.tools.filter((tool) => tool.id === 'openclaw' || tool.id === 'codex');
    const chat = 'Chat is unavailable: OpenClaw doesn\'t offer chat.send.';
    const readiness = 'OpenClaw 2026.10.9 was installed, but its readiness wasn\'t confirmed in time. Check OpenClaw\'s status.';
    const at = (version: string, runs: unknown[]) => buildToolsStatus(snapshot({
      policy: twoTools,
      installed: {
        openclaw: { version, admittedAt: null, admission: 'none', source: 'package-json' },
        codex: { version: '0.166.0', admittedAt: null, admission: 'none', source: 'package-json' },
      },
      runs: runs as any,
    }));
    const degradedRun = (error: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
      run('succeeded-degraded', 'succeeded-degraded', { result: { action: 'update', from: '2026.9.9', to: '2026.10.9' }, error, ...extra });

    for (const [error, reason] of [
      [{ id: 'CONTRACT_REQUIRED_PROBE_FAILED', message: chat, nextAction: 'retry-checks' }, chat],
      [{ id: 'NATIVE_READINESS_UNVERIFIED', message: readiness, nextAction: 'openclaw-status' }, readiness],
      [null, 'Updated, but some Portal checks did not pass.'],
    ] as const) {
      const status = at('2026.10.9', [degradedRun(error)]);
      const openclaw = status.tools.find((tool) => tool.id === 'openclaw')!;
      expect(openclaw).toMatchObject({ status: 'degraded', statusReason: reason, lastRun: { state: 'succeeded-degraded' } });
      expect(openclaw.runActions).toContain('retry-checks');
      expect(status.summary).toEqual({
        status: 'attention', text: 'OpenClaw is running with some Portal features off.', counts: { degraded: 1, ok: 1 },
      });
    }
    // A newer recommended version never hides it.
    expect(at('2026.9.9', [degradedRun({ id: 'CONTRACT_REQUIRED_PROBE_FAILED', message: chat })]).tools.find((tool) => tool.id === 'openclaw'))
      .toMatchObject({ status: 'degraded', statusReason: chat });
    // A later run that succeeds (the checks passed on retry) clears it.
    const retried = run('succeeded', 'succeeded', {
      runId: '0b6c2f1e-4a59-4d38-9d0e-2a7f5c1b9e05', createdAt: '2026-10-30T11:59:30.000Z', result: { action: 'retry-checks' },
    });
    const cleared = at('2026.10.9', [retried, degradedRun({ id: 'CONTRACT_REQUIRED_PROBE_FAILED', message: chat })]);
    expect(cleared.tools.find((tool) => tool.id === 'openclaw')).toMatchObject({ status: 'ok', statusReason: 'Up to date.' });
    expect(cleared.summary).toMatchObject({ status: 'ok', text: 'All installed AI tools are up to date.' });
    // A later pre-flight that passed, then a refused update, changed nothing and checked no Portal feature: still
    // degraded with the update's reason, while the card's last run is the newest one.
    const passedPreflight = run('succeeded', 'succeeded', {
      runId: '0b6c2f1e-4a59-4d38-9d0e-2a7f5c1b9e06', createdAt: '2026-10-30T11:59:10.000Z',
      result: { action: 'preflight', from: '2026.10.9', to: '2026.10.9', preflight: 'preflight.json' },
    });
    const refusedUpdate = run('refused', 'refused', {
      runId: '0b6c2f1e-4a59-4d38-9d0e-2a7f5c1b9e07', createdAt: '2026-10-30T11:59:20.000Z',
      result: { action: 'update', from: '2026.10.9', to: null },
      error: { id: 'HARNESS_ALREADY_CURRENT', message: 'OpenClaw 2026.10.9 is already installed. Nothing to update.' },
    });
    const degradedChat = degradedRun({ id: 'CONTRACT_REQUIRED_PROBE_FAILED', message: chat, nextAction: 'retry-checks' });
    for (const runs of [[passedPreflight, degradedChat], [refusedUpdate, passedPreflight, degradedChat]]) {
      const kept = at('2026.10.9', runs);
      expect(kept.tools.find((tool) => tool.id === 'openclaw')).toMatchObject({
        status: 'degraded', statusReason: chat, lastRun: { runId: (runs[0] as { runId: string }).runId },
      });
      expect(kept.summary.text).toBe('OpenClaw is running with some Portal features off.');
    }
    // Two degraded tools share one sentence.
    expect(computeToolsSummary([
      { id: 'a', label: 'OpenClaw', status: 'degraded' }, { id: 'b', label: 'Codex', status: 'degraded' },
    ] as ToolStatusItem[], null).text).toBe('OpenClaw and Codex are running with some Portal features off.');
  });

  test('the OpenClaw card carries the PF-8 disk lines of its latest pre-flight, only when that pre-flight recorded them', () => {
    const preflightRun = (runId: string, createdAt: string, refusals: unknown[] | null, state = refusals ? 'refused' : 'succeeded') => ({
      ...run(state, state, {
        runId, createdAt, endedAt: createdAt,
        result: { action: 'preflight', from: '2026.9.9', to: refusals ? null : '2026.9.9', preflight: 'preflight.json' },
        error: refusals ? { id: 'PF8_DISK_SPACE', message: 'Needs 49.0 GB free on /, has 19.0 GB.', refusals } : null,
      }),
    });
    const refused = preflightRun(RUN_ID, '2026-10-30T11:50:00.000Z', [
      { id: 'PF8_DISK_SPACE', check: 'PF-8', message: 'Needs 49.0 GB free on /, has 19.0 GB.' },
      { id: 'PF7_NODE', check: 'PF-7', message: 'Node.js 24.21.0 must be updated.' },
      { id: 'PF8_INODES', check: 'PF-8', message: 'Needs 900000 free inodes on /, has 12.' },
    ]);
    // A later run without a pre-flight (feature checks) keeps the line; codex never gets one.
    const later = { ...run('succeeded', 'succeeded', { runId: '0b6c2f1e-4a59-4d38-9d0e-2a7f5c1b9e03', createdAt: '2026-10-30T11:55:00.000Z', result: { action: 'retry-checks' } }) };
    const status = buildToolsStatus(snapshot({ runs: [later, refused] as any }));
    expect(status.tools.find((tool) => tool.id === 'openclaw')!.diskCheck).toEqual({
      messages: ['Needs 49.0 GB free on /, has 19.0 GB.', 'Needs 900000 free inodes on /, has 12.'], checkedAt: '2026-10-30T11:50:00.000Z',
    });
    expect(status.tools.find((tool) => tool.id === 'codex')!).not.toHaveProperty('diskCheck');
    // A newer pre-flight that passed PF-8 recorded no numbers: nothing is shown (never a stale line).
    const passed = preflightRun('0b6c2f1e-4a59-4d38-9d0e-2a7f5c1b9e04', '2026-10-30T11:58:00.000Z', null);
    expect(buildToolsStatus(snapshot({ runs: [passed, later, refused] as any })).tools.find((tool) => tool.id === 'openclaw')!.diskCheck).toBeNull();
    expect(buildToolsStatus(snapshot()).tools.find((tool) => tool.id === 'openclaw')!.diskCheck).toBeNull();
  });

  test('Stop is refused during Ollama/Agent Zero swap, Hermes stage and OpenClaw\'s switch-over; offered otherwise', () => {
    const live = (tool: string, phase: string, extra: Record<string, unknown> = {}) => buildToolsStatus(snapshot({
      runs: [run('running', phase, { tool, steps: [{ id: phase, label: phase, state: 'running', startedAt: null, endedAt: null, detail: null, evidence: [] }], ...extra }) as any],
      lockOwner: { runId: RUN_ID, pid: 4242, bootId: 'boot-1' },
    }), { processAlive: () => true }).activeRun!;
    expect(live('ollama', 'swap').stopRefusal).toBe(
      'Ollama\'s installer is switching versions and restarting the local model server; stopping it now could leave Ollama stopped. Stop is available again when this step ends.');
    expect(live('agent-zero', 'swap').stopRefusal).toMatch(/^Agent Zero is switching to its new container; .* Stop is available again when this step ends\.$/);
    expect(live('hermes', 'stage').stopRefusal).toMatch(/^Hermes is building its new version in one long step; .* Stop is available again when this step ends\.$/);
    // The step is read from the running step too (phase not yet moved on).
    expect(live('hermes', 'resolve', { steps: [{ id: 'stage', label: 'Building', state: 'running', startedAt: null, endedAt: null, detail: null, evidence: [] }] }).stopRefusal)
      .toMatch(/^Hermes is building/);
    expect(live('openclaw', 'native', { native: { phase: 'activating' } }).stopRefusal).toMatch(/^OpenClaw is switching over and restarting;/);
    for (const [tool, phase, extra] of [['hermes', 'swap', {}], ['hermes', 'probe-candidate', {}], ['ollama', 'probe', {}], ['agent-zero', 'resolve', {}],
      ['codex', 'swap', {}], ['openclaw', 'native', { native: { phase: 'validating' } }], ['openclaw', 'contract', {}]] as const) {
      expect([tool, phase, live(tool, phase, extra).stopRefusal]).toEqual([tool, phase, null]);
    }
    expect(buildToolsStatus(snapshot({ runs: [run('queued', 'queued', { tool: 'codex' }) as any] })).activeRun!.stopRefusal)
      .toBe('The update has not started yet. Stop is available once it starts.');
  });

  test('Stop signals toolctl alone, never the whole run unit (its children include installers mid-switch)', () => {
    const args = SYSTEMD_TOOLS_RUN_STOP_ARGS(RUN_ID);
    expect(args).toEqual(['kill', '--kill-who=main', '--signal=SIGTERM', `bridgesllm-tools@${RUN_ID}.service`]);
    expect(args).not.toContain('stop');
    // The unit stays KillMode=control-group with no SIGKILL; a Portal Stop must not rely on it.
    const unit = fs.readFileSync(path.join(REPO_ROOT, 'installer/systemd/bridgesllm-tools@.service'), 'utf8');
    expect(unit).toMatch(/^SendSIGKILL=no$/m);
  });

  test('an interrupted npm CLI run asks for its Re-check, never for an OpenClaw repair, whatever its version read', () => {
    const interrupted = { ...run('recovery-required'), tool: 'clawhub', error: { id: 'TOOLS_RUN_INTERRUPTED', message: 'Stopped mid-swap.' } };
    for (const read of ['present', 'absent', 'unreadable'] as const) {
      const status = buildToolsStatus(snapshot({ runs: [interrupted as any], installedReads: { clawhub: read } }));
      expect(status.recovery).toMatchObject({
        action: { id: 'requalify', label: 'Re-check ClawHub' }, tool: 'clawhub',
        title: 'The ClawHub update needs to be checked.', detail: 'Stopped mid-swap.',
      });
      expect(status.summary.text).toBe('The ClawHub update needs to be checked. Re-check ClawHub to continue.');
      // P7: that Re-check is the only run offered, and only for ClawHub; no card button anywhere.
      expect([read, status.tools.find((tool) => tool.id === 'clawhub')!.runActions]).toEqual([read, ['requalify']]);
      expect(status.tools.filter((tool) => tool.id !== 'clawhub').flatMap((tool) => tool.runActions)).toEqual([]);
      expect(status.tools.flatMap((tool) => tool.actions)).toEqual([]);
    }
    // The Re-check's own finished run is newer: recovery clears, whatever it found.
    const recheck = { ...run('refused'), runId: '0b6c2f1e-4a59-4d38-9d0e-2a7f5c1b9e06', createdAt: '2026-10-30T11:59:30.000Z', tool: 'clawhub',
      result: { action: 'requalify' }, error: { id: 'NPM_TOOL_ABSENT', message: 'ClawHub is not installed.' } };
    const cleared = buildToolsStatus(snapshot({ runs: [recheck, interrupted] as any, installedReads: { clawhub: 'absent' } }));
    expect(cleared.recovery).toBeNull();
    expect(cleared.tools.find((tool) => tool.id === 'clawhub')).toMatchObject({ status: 'not-installed', lastRun: { errorId: 'NPM_TOOL_ABSENT' } });
    // Without the per-tool runner nothing is offered; the recovery text stays.
    const readOnly = buildToolsStatus(snapshot({ runs: [interrupted as any], runner: { installed: false, reason: 'No runner.' } }));
    expect(readOnly.recovery?.action.id).toBe('requalify');
    expect(readOnly.tools.flatMap((tool) => tool.runActions)).toEqual([]);
  });

  test('without the per-tool runner every card is read-only and says why', () => {
    const status = buildToolsStatus(snapshot({
      runner: { installed: false, reason: 'This installation does not include the per-tool AI updater yet.' },
    }));
    expect(status.runner).toEqual({ installed: false, reason: 'This installation does not include the per-tool AI updater yet.' });
    expect(status.tools.find((tool) => tool.id === 'openclaw')).toMatchObject({ status: 'update-available' });
    expect(status.tools.flatMap((tool) => [...tool.actions, ...tool.runActions])).toEqual([]);
  });

  test('an invalid policy blocks without tools', () => {
    const status = buildToolsStatus(snapshot({ policy: null, policyError: 'policy schema must be bridgesllm.tools.policy.v2' }));
    expect(status.tools).toEqual([]);
    expect(status.policy).toMatchObject({ valid: false, error: 'policy schema must be bridgesllm.tools.policy.v2' });
    expect(status.summary.status).toBe('blocked');
  });

  test('the summary is always derived from the items (randomized)', () => {
    const statuses: ToolStatusItem['status'][] = [
      'ok', 'update-available', 'below-floor', 'drifted-requalifying', 'drifted-failed', 'degraded', 'blocked',
      'updating', 'failed-last-run', 'recovery-required', 'unknown-retrying', 'not-checked',
    ];
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const recovery: ToolsRecovery = { kind: 'legacy-ledger', title: 'T.', detail: 'D', action: { id: 'recover-legacy', label: 'Recover' } };
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const items = Array.from({ length: 1 + Math.floor(random() * 8) }, (_, index) => ({
        id: `t${index}`, label: `Tool ${index}`, status: statuses[Math.floor(random() * statuses.length)],
      })) as ToolStatusItem[];
      const withRecovery = random() < 0.2 ? recovery : null;
      const summary = computeToolsSummary(items, withRecovery);
      const has = (...values: string[]) => items.some((item) => values.includes(item.status));
      const expected = withRecovery ? 'recovery-required'
        : has('below-floor', 'blocked') ? 'blocked'
          : has('update-available', 'degraded', 'drifted-requalifying', 'drifted-failed', 'failed-last-run', 'unknown-retrying', 'updating', 'not-checked')
            ? 'attention' : 'ok';
      expect(summary.status).toBe(expected);
      expect(Object.values(summary.counts).reduce((a, b) => a + b, 0)).toBe(items.length);
    }
  });

  test('calendar and semantic versions compare numerically', () => {
    expect(compareVersions('2026.10.9', '2026.9.9')).toBe(1);
    expect(compareVersions('2026.10.10-beta.5', '2026.10.10')).toBe(-1);
    expect(compareVersions('2026.10.10-beta.5', '2026.10.9')).toBe(1);
    expect(compareVersions('2.14', '2.14.0')).toBe(0);
    expect(() => compareVersions('latest', '1.0.0')).toThrow();
  });

  test('legacy roots match toolctl exactly', () => {
    const source = fs.readFileSync(TOOLCTL_PATH, 'utf8');
    const body = source.slice(source.indexOf('def legacy_roots('), source.indexOf('def open_legacy_roots('));
    const ids = Array.from(body.matchAll(/\("([a-z0-9-]+)", /g)).map((match) => match[1]);
    expect(ids).toEqual([...LEGACY_ROOT_IDS]);
    const paths = legacyRootPaths({
      stateRoot: '/s', installerStateRoot: '/i', gatewayFenceMarker: '/m', gatewayFencePermit: '/p',
      openclawStateDir: '/o', policyPath: '/policy.json', npmGlobalRoot: '/n', toolctlPath: '/t', toolsUnitPaths: ['/u'],
    });
    expect(paths.map((root) => root.path)).toEqual([
      '/i/openclaw-2026.9.1-migration-v2', '/i/openclaw-native-chat-v1', '/i/native-cli-bundle-v1',
      '/i/native-cli-bundle-v1.terminal-intent.json', '/m', '/p', '/o/.bridgesllm-tested-pair-commit-v5.json',
      '/o/.bridgesllm-ask-user-tested-pair-v1',
    ]);
  });
});

describe('tools state files', () => {
  let root: string;
  let paths: ToolsPaths;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-status-'));
    fs.mkdirSync(path.join(root, 'var/lib/bridgesllm'), { recursive: true });
    fs.mkdirSync(path.join(root, 'usr/lib/node_modules/openclaw'), { recursive: true });
    fs.writeFileSync(path.join(root, 'usr/lib/node_modules/openclaw/package.json'), JSON.stringify({ version: '2026.9.9' }));
    fs.mkdirSync(path.join(root, 'usr/lib/node_modules/@openai/codex'), { recursive: true });
    fs.writeFileSync(path.join(root, 'usr/lib/node_modules/@openai/codex/package.json'), JSON.stringify({ version: '0.163.0' }));
    paths = {
      stateRoot: path.join(root, 'var/lib/bridgesllm/tools'),
      installerStateRoot: path.join(root, 'var/lib/bridgesllm-installer'),
      gatewayFenceMarker: path.join(root, 'var/lib/bridgesllm/openclaw-gateway-authorization-fence.v1'),
      gatewayFencePermit: path.join(root, 'run/bridgesllm/openclaw-gateway-migration-permit.v1'),
      openclawStateDir: path.join(root, 'root/.openclaw'),
      policyPath: POLICY_PATH,
      npmGlobalRoot: path.join(root, 'usr/lib/node_modules'),
      toolctlPath: path.join(root, 'opt/portal/installer/tools/bridgesllm-toolctl.py'),
      toolsUnitPaths: [path.join(root, 'etc/systemd/system/bridgesllm-tools@.service')],
    };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function request(overrides: Partial<ToolsRunRequest> = {}): ToolsRunRequest {
    return {
      schema: 'bridgesllm.tools.request.v1', runId: RUN_ID, tool: 'openclaw', action: 'update', target: 'recommended',
      channel: 'stable', requestedBy: 'owner-1', requestedAt: '2026-10-30T12:00:00.000Z', portalVersion: '5.2.0',
      policySha256: null, acknowledgements: { confirmation: true, maintenanceWindow: true }, backup: null, ...overrides,
    };
  }

  test('queuing writes a private run directory with request and queued status', () => {
    const status = writeToolsRunRequest(paths, request());
    expect(status).toMatchObject({ schema: 'bridgesllm.tools.run.v1', runId: RUN_ID, state: 'queued', phase: 'queued', steps: [] });
    const runDir = path.join(paths.stateRoot, 'runs', RUN_ID);
    for (const directory of [paths.stateRoot, path.join(paths.stateRoot, 'runs'), runDir]) {
      expect(fs.lstatSync(directory).mode & 0o777).toBe(0o700);
    }
    for (const file of ['request.json', 'status.json']) {
      expect(fs.lstatSync(path.join(runDir, file)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'request.json'), 'utf8'))).toMatchObject({ runId: RUN_ID, tool: 'openclaw' });
    expect(fs.readdirSync(runDir).sort()).toEqual(['request.json', 'status.json']);
    expect(() => writeToolsRunRequest(paths, request())).toThrow();
    expect(() => writeToolsRunRequest(paths, request({ runId: '../escape' }))).toThrow('invalid run id');
  });

  test('a launch failure is recorded as failed with a history line', () => {
    writeToolsRunRequest(paths, request());
    markToolsRunLaunchFailed(paths, RUN_ID, 'systemctl: unit not found', '2026-10-30T12:00:05.000Z');
    const status = JSON.parse(fs.readFileSync(path.join(paths.stateRoot, 'runs', RUN_ID, 'status.json'), 'utf8'));
    expect(status).toMatchObject({ state: 'failed', error: { id: 'TOOLS_RUN_LAUNCH_FAILED' } });
    const history = fs.readFileSync(path.join(paths.stateRoot, 'history.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(history).toEqual([expect.objectContaining({ runId: RUN_ID, outcome: 'failed', errorId: 'TOOLS_RUN_LAUNCH_FAILED' })]);
    expect(fs.lstatSync(path.join(paths.stateRoot, 'history.jsonl')).mode & 0o777).toBe(0o600);
  });

  test('the snapshot reads policy, versions, legacy roots, runs and history from files', () => {
    writeToolsRunRequest(paths, request());
    fs.mkdirSync(path.dirname(paths.gatewayFencePermit), { recursive: true });
    fs.writeFileSync(paths.gatewayFencePermit, '{}');
    fs.writeFileSync(path.join(paths.stateRoot, 'history.jsonl'),
      `${JSON.stringify({ runId: 'r1', tool: 'openclaw', outcome: 'refused' })}\nnot json\n`);
    const read = readToolsSnapshot(paths, Date.parse('2026-10-30T12:00:00Z'));
    expect(read.policyError).toBeNull();
    expect(read.policySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(read.installed.openclaw).toMatchObject({ version: '2026.9.9', source: 'package-json' });
    expect(read.installed.codex.version).toBe('0.163.0');
    expect(read.installed['claude-code'].version).toBeNull();
    expect(read.installedReads).toMatchObject({ openclaw: 'ok', codex: 'ok', 'claude-code': 'absent', hermes: 'unreadable' });
    expect(read.runner).toEqual({ installed: false, reason: 'This installation does not include the per-tool AI updater yet.' });
    fs.mkdirSync(path.dirname(paths.toolctlPath), { recursive: true });
    fs.writeFileSync(paths.toolctlPath, '#!/usr/bin/python3\n');
    expect(readToolsSnapshot(paths).runner).toEqual({ installed: false, reason: 'The per-tool AI updater service is not installed on this server.' });
    fs.mkdirSync(path.dirname(paths.toolsUnitPaths[0]), { recursive: true });
    fs.writeFileSync(paths.toolsUnitPaths[0], '[Unit]\n');
    expect(readToolsSnapshot(paths).runner).toEqual({ installed: true, reason: null });
    expect(read.legacyOpen).toEqual([{ id: 'gateway-migration-permit', path: paths.gatewayFencePermit }]);
    expect(read.runs.map((entry) => entry.runId)).toEqual([RUN_ID]);
    expect(read.history).toEqual([expect.objectContaining({ runId: 'r1', outcome: 'refused' })]);
  });

  test('admission records give the badge; a live tree that moved away from its record is drift', () => {
    fs.mkdirSync(path.join(paths.stateRoot, 'admission'), { recursive: true });
    fs.writeFileSync(path.join(paths.stateRoot, 'admission', 'codex.json'), JSON.stringify({
      version: '0.163.0', admittedAt: '2026-10-29T10:00:00Z', admittedBy: 'requalify:5d1f8a3c-6b72-4e19-8c40-7a2e9f0d3b12',
    }));
    fs.mkdirSync(path.join(root, 'usr/lib/node_modules/clawhub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'usr/lib/node_modules/clawhub/package.json'), '{"version": ');
    let read = readToolsSnapshot(paths, Date.parse('2026-10-30T12:00:00Z'));
    expect(read.installed.codex).toEqual({
      version: '0.163.0', admittedAt: '2026-10-29T10:00:00Z', admission: 'requalified', source: 'admission-record', authority: null, bytesVerified: null,
    });
    expect(read.drift).toEqual({});
    expect(read.installedReads?.clawhub).toBe('unreadable');
    fs.writeFileSync(path.join(root, 'usr/lib/node_modules/@openai/codex/package.json'), JSON.stringify({ version: '0.166.0' }));
    read = readToolsSnapshot(paths, Date.parse('2026-10-30T12:00:00Z'));
    expect(read.installed.codex).toMatchObject({ version: '0.166.0', admission: 'unverified', source: 'package-json' });
    expect(read.drift).toEqual({ codex: { admittedVersion: '0.163.0', liveVersion: '0.166.0' } });
  });

  test('OpenCode is read from its managed launcher link and offered its own update and re-check', () => {
    const runtimes = path.join(root, 'usr/local/lib/bridgesllm-runtimes');
    const bin = path.join(root, 'usr/local/bin');
    for (const version of ['1.19.4', '1.19.5']) {
      fs.mkdirSync(path.join(runtimes, 'opencode', version), { recursive: true });
      fs.writeFileSync(path.join(runtimes, 'opencode', version, 'opencode'), '#!/bin/sh\n');
    }
    fs.mkdirSync(bin, { recursive: true });
    paths = { ...paths, harnessRuntimeRoot: runtimes, harnessBinDir: bin };
    for (const [file, text] of [[paths.toolctlPath, '#!/usr/bin/python3\n'], [paths.toolsUnitPaths[0], '[Unit]\n']]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    const at = Date.parse('2026-10-30T12:00:00Z');
    expect(readToolsSnapshot(paths, at).installedReads?.opencode).toBe('absent');
    fs.symlinkSync(path.join(runtimes, 'opencode', '1.19.4', 'opencode'), path.join(bin, 'opencode'));
    let read = readToolsSnapshot(paths, at);
    expect(read.installed.opencode).toEqual({ version: '1.19.4', admittedAt: null, admission: 'none', source: 'package-json' });
    const item = buildToolsStatus(read).tools.find((tool) => tool.id === 'opencode')!;
    expect(item).toMatchObject({ status: 'update-available', actions: ['update-recommended'], runActions: ['update', 'requalify'], restartsGateway: false, newestNotOffered: true });
    // A toolctl record for the live version is the badge; a launcher moved off it is drift (re-check first).
    fs.mkdirSync(path.join(paths.stateRoot, 'admission'), { recursive: true });
    fs.writeFileSync(path.join(paths.stateRoot, 'admission', 'opencode.json'), JSON.stringify({
      schema: 'bridgesllm.tools.harness-admission.v1', version: '1.19.4', admittedAt: '2026-10-30T11:00:00.000Z', admittedBy: 'requalify:5d1f8a3c-6b72-4e19-8c40-7a2e9f0d3b12',
    }));
    expect(readToolsSnapshot(paths, at).installed.opencode).toMatchObject({ version: '1.19.4', admission: 'requalified', source: 'admission-record' });
    fs.unlinkSync(path.join(bin, 'opencode'));
    fs.symlinkSync(path.join(runtimes, 'opencode', '1.19.5', 'opencode'), path.join(bin, 'opencode'));
    read = readToolsSnapshot(paths, at);
    expect(read.drift).toEqual({ opencode: { admittedVersion: '1.19.4', liveVersion: '1.19.5' } });
    expect(buildToolsStatus(read).tools.find((tool) => tool.id === 'opencode')).toMatchObject({ status: 'drifted-requalifying', actions: ['requalify'] });
    // An unmanaged copy (not the launcher link) is never given a guessed version.
    fs.unlinkSync(path.join(bin, 'opencode'));
    fs.writeFileSync(path.join(bin, 'opencode'), '#!/bin/sh\n');
    fs.rmSync(path.join(paths.stateRoot, 'admission', 'opencode.json'));
    read = readToolsSnapshot(paths, at);
    expect(read.installedReads?.opencode).toBe('unreadable');
    expect(read.installed.opencode.version).toBeNull();
  });

  test('a launcher with no cheap version read is "not checked yet" and offered only its Re-check', () => {
    const bin = path.join(root, 'usr/local/bin');
    fs.mkdirSync(bin, { recursive: true });
    paths = { ...paths, harnessBinDir: bin };
    const at = Date.parse('2026-10-30T12:00:00Z');
    expect(readToolsSnapshot(paths, at).installedReads?.['grok-build']).toBe('absent');
    fs.writeFileSync(path.join(bin, 'grok'), '#!/bin/sh\n');
    const read = readToolsSnapshot(paths, at);
    expect(read.installedReads?.['grok-build']).toBe('present');
    expect(read.installed['grok-build'].version).toBeNull();
    // Hermes: offered the Re-check first (it establishes the version), never an update before that.
    fs.writeFileSync(path.join(bin, 'hermes'), '#!/bin/sh\n');
    expect(readToolsSnapshot(paths, at).installedReads?.hermes).toBe('present');
    expect(buildToolsStatus(snapshot({
      installed: { hermes: { version: null, admittedAt: null, admission: 'none', source: null } }, installedReads: { hermes: 'present' },
    })).tools.find((tool) => tool.id === 'hermes')).toMatchObject({
      status: 'not-checked', statusReason: 'Installed; not checked yet. Re-check Hermes to confirm its version.',
      actions: ['requalify'], runActions: ['requalify'],
    });
    // Nothing is checking it: the summary says "not checked yet", never "being checked".
    expect(computeToolsSummary([
      { id: 'openclaw', label: 'OpenClaw', status: 'ok' }, { id: 'hermes', label: 'Hermes', status: 'not-checked' },
    ] as ToolStatusItem[], null)).toMatchObject({ status: 'attention', text: 'Hermes is not checked yet.' });
    // Once re-checked: its version, and the recommended (policy newestProven) and newest updates.
    const hermes = (version: string) => buildToolsStatus(snapshot({
      installed: { hermes: { version, admittedAt: '2026-10-30T11:00:00.000Z', admission: 'requalified', source: null } },
      installedReads: { hermes: 'present' },
    })).tools.find((tool) => tool.id === 'hermes')!;
    expect(hermes('0.22.2')).toMatchObject({
      status: 'update-available', actions: ['update-recommended'], runActions: ['update', 'requalify'],
    });
    expect(hermes('0.22.5')).toMatchObject({
      status: 'ok', actions: ['requalify'], runActions: ['update', 'requalify'],
    });
    // A runnable tool in that state gets the Re-check (which establishes the version) and never an update.
    const item = buildToolsStatus(snapshot({
      installed: { opencode: { version: null, admittedAt: null, admission: 'none', source: null } },
      installedReads: { opencode: 'present' },
    })).tools.find((tool) => tool.id === 'opencode')!;
    expect(item).toMatchObject({ status: 'not-checked', actions: ['requalify'], runActions: ['requalify'] });
    expect(item.statusReason).toBe('Installed; not checked yet. Re-check OpenCode to confirm its version.');
    // Never while another run is open.
    expect(buildToolsStatus(snapshot({
      installed: { opencode: { version: null, admittedAt: null, admission: 'none', source: null } },
      installedReads: { opencode: 'present' }, runs: [run('running', 'running', { tool: 'codex' }) as any],
    }), { processAlive: () => true }).tools.find((tool) => tool.id === 'opencode')).toMatchObject({ actions: [], runActions: [] });
  });

  test('Grok Build is offered its Re-check, then only the Portal-tested version (no checksums, no "newest")', () => {
    const bin = path.join(root, 'usr/local/bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'grok'), '#!/bin/sh\n');
    paths = { ...paths, harnessBinDir: bin };
    for (const [file, text] of [[paths.toolctlPath, '#!/usr/bin/python3\n'], [paths.toolsUnitPaths[0], '[Unit]\n']]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    const at = Date.parse('2026-10-30T12:00:00Z');
    const grok = (): ToolStatusItem => buildToolsStatus(readToolsSnapshot(paths, at)).tools.find((tool) => tool.id === 'grok-build')!;
    expect(grok()).toMatchObject({ status: 'not-checked', actions: ['requalify'], runActions: ['requalify'] });
    expect(grok().statusReason).toBe('Installed; not checked yet. Re-check Grok Build to confirm its version.');
    // The re-check's record gives the version; at the tested version only its Re-check is offered (no "newest", N6).
    fs.mkdirSync(path.join(paths.stateRoot, 'admission'), { recursive: true });
    const record = (version: string) => fs.writeFileSync(path.join(paths.stateRoot, 'admission', 'grok-build.json'), JSON.stringify({
      schema: 'bridgesllm.tools.harness-admission.v1', version, admittedAt: '2026-10-30T11:00:00.000Z', admittedBy: 'requalify:5d1f8a3c-6b72-4e19-8c40-7a2e9f0d3b12',
    }));
    record('1.0.62');
    expect(grok()).toMatchObject({
      status: 'ok', installed: { version: '1.0.62', admission: 'requalified' }, actions: ['requalify'], runActions: ['update', 'requalify'],
    });
    // A vendor self-update newer than tested: still no "newest" but its Re-check; below the tested version: the
    // recommended update and no Re-check.
    record('1.0.70');
    expect(grok()).toMatchObject({ status: 'ok', newerThanTested: true, actions: ['requalify'] });
    record('1.0.61');
    expect(grok()).toMatchObject({ status: 'below-floor', actions: ['update-recommended'] });
    // Antigravity, the same rule.
    fs.writeFileSync(path.join(bin, 'agy'), '#!/bin/sh\n');
    expect(buildToolsStatus(readToolsSnapshot(paths, at)).tools.find((tool) => tool.id === 'antigravity'))
      .toMatchObject({ status: 'not-checked', actions: ['requalify'], runActions: ['requalify'] });
  });

  test('the admission record\'s source authority and bytesVerified reach the card (same file, bounded)', () => {
    const bin = path.join(root, 'usr/local/bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'grok'), '#!/bin/sh\n');
    paths = { ...paths, harnessBinDir: bin };
    const at = Date.parse('2026-10-30T12:00:00Z');
    fs.mkdirSync(path.join(paths.stateRoot, 'admission'), { recursive: true });
    const record = (source: unknown) => fs.writeFileSync(path.join(paths.stateRoot, 'admission', 'grok-build.json'), JSON.stringify({
      schema: 'bridgesllm.tools.harness-admission.v1', version: '1.0.70', admittedAt: '2026-10-30T11:00:00.000Z',
      admittedBy: 'requalify:5d1f8a3c-6b72-4e19-8c40-7a2e9f0d3b12', source,
    }));
    record({ kind: 'vendor', authority: 'vendor-self-update', bytesVerified: false, provenDigestMatch: null });
    expect(readToolsSnapshot(paths, at).installed['grok-build']).toEqual({
      version: '1.0.70', admittedAt: '2026-10-30T11:00:00.000Z', admission: 'requalified', source: 'admission-record',
      authority: 'vendor-self-update', bytesVerified: false,
    });
    record({ kind: 'vendor', authority: '<b>odd</b>', bytesVerified: 'no' });
    expect(readToolsSnapshot(paths, at).installed['grok-build']).toMatchObject({ authority: null, bytesVerified: null });
    record(undefined);
    expect(readToolsSnapshot(paths, at).installed['grok-build']).toMatchObject({ authority: null, bytesVerified: null });
  });

  test('Agent Zero is "Not configured" without its env file, else offered its Re-check and only the pinned image', () => {
    const etc = path.join(root, 'etc/bridgesllm');
    paths = { ...paths, agentZeroEnvPath: path.join(etc, 'agent-zero.env') };
    for (const [file, text] of [[paths.toolctlPath, '#!/usr/bin/python3\n'], [paths.toolsUnitPaths[0], '[Unit]\n']]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    const at = Date.parse('2026-10-30T12:00:00Z');
    const a0 = (): ToolStatusItem => buildToolsStatus(readToolsSnapshot(paths, at)).tools.find((tool) => tool.id === 'agent-zero')!;
    expect(a0()).toMatchObject({ status: 'not-installed', statusReason: 'Not configured.', actions: [], runActions: [] });
    fs.mkdirSync(etc, { recursive: true });
    fs.writeFileSync(path.join(etc, 'agent-zero.env'), 'A0_AUTH_LOGIN=portal\n');
    expect(a0()).toMatchObject({ status: 'not-checked', actions: ['requalify'], runActions: ['requalify'] });
    fs.mkdirSync(path.join(paths.stateRoot, 'admission'), { recursive: true });
    fs.writeFileSync(path.join(paths.stateRoot, 'admission', 'agent-zero.json'), JSON.stringify({
      schema: 'bridgesllm.tools.harness-admission.v1', version: '2.13', admittedAt: '2026-10-30T11:00:00.000Z', admittedBy: 'requalify:5d1f8a3c-6b72-4e19-8c40-7a2e9f0d3b12',
    }));
    expect(a0()).toMatchObject({ installed: { version: '2.13' }, actions: ['update-recommended'], runActions: ['update', 'requalify'] });
  });

  test('a 5.0.x OpenCode or Hermes under /opt/bridgesllm/tools reads its version, so its Update is offered (F4/F5)', () => {
    const bin = path.join(root, 'usr/local/bin');
    const legacy = path.join(root, 'opt/bridgesllm/tools');
    fs.mkdirSync(bin, { recursive: true });
    paths = { ...paths, harnessRuntimeRoot: path.join(root, 'usr/local/lib/bridgesllm-runtimes'), harnessLegacyRoot: legacy, harnessBinDir: bin };
    for (const [file, text] of [[paths.toolctlPath, '#!/usr/bin/python3\n'], [paths.toolsUnitPaths[0], '[Unit]\n']]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    // The layout Portal 5.0.10 left on the TEST server: direct absolute links into the private tree.
    fs.mkdirSync(path.join(legacy, 'opencode', '1.18.29'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'opencode', '1.18.29', 'opencode'), '#!/bin/sh\n');
    fs.mkdirSync(path.join(legacy, 'hermes', '0.21.1', '.venv', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'hermes', '0.21.1', '.venv', 'bin', 'hermes'), '#!/bin/sh\n');
    fs.symlinkSync(path.join(legacy, 'opencode', '1.18.29', 'opencode'), path.join(bin, 'opencode'));
    fs.symlinkSync(path.join(legacy, 'hermes', '0.21.1', '.venv', 'bin', 'hermes'), path.join(bin, 'hermes'));
    const at = Date.parse('2026-10-30T12:00:00Z');
    const card = (id: string) => buildToolsStatus(readToolsSnapshot(paths, at)).tools.find((tool) => tool.id === id)!;
    expect(card('opencode')).toMatchObject({
      installed: { version: '1.18.29' }, status: 'below-floor', actions: ['update-recommended'], runActions: ['update', 'requalify'],
    });
    expect(card('hermes')).toMatchObject({
      installed: { version: '0.21.1' }, status: 'below-floor', actions: ['update-recommended'], runActions: ['update', 'requalify'],
    });
    // Only that exact shape: a relative link, another entry or a non-version directory is never read as a version.
    for (const [id, target] of [
      ['opencode', '../../../opt/bridgesllm/tools/opencode/1.18.29/opencode'],
      ['opencode', path.join(legacy, 'opencode', '1.18.29', 'bin', 'opencode')],
      ['opencode', path.join(legacy, 'opencode', 'latest', 'opencode')],
      ['hermes', path.join(legacy, 'hermes', '0.21.1', 'hermes')],
      ['hermes', `${legacy}/hermes/./0.21.1/.venv/bin/hermes`],
    ]) {
      fs.unlinkSync(path.join(bin, id));
      fs.symlinkSync(target, path.join(bin, id));
      expect([id, target, card(id).installed.version, card(id).actions.includes('update-recommended')]).toEqual([id, target, null, false]);
    }
    expect(card('opencode').status).toBe('unknown-retrying');
    expect(card('hermes').status).toBe('not-checked');
  });

  test('a launcher that is gone is not installed, even with an old admission record; Install is offered', () => {
    const bin = path.join(root, 'usr/local/bin');
    fs.mkdirSync(bin, { recursive: true });
    paths = { ...paths, harnessBinDir: bin };
    for (const [file, text] of [[paths.toolctlPath, '#!/usr/bin/python3\n'], [paths.toolsUnitPaths[0], '[Unit]\n']]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    fs.mkdirSync(path.join(paths.stateRoot, 'admission'), { recursive: true });
    fs.writeFileSync(path.join(paths.stateRoot, 'admission', 'ollama.json'), JSON.stringify({
      schema: 'bridgesllm.tools.harness-admission.v1', version: '0.40.6', admittedAt: '2026-10-30T11:00:00.000Z', admittedBy: 'run:5d1f8a3c-6b72-4e19-8c40-7a2e9f0d3b12',
    }));
    const at = Date.parse('2026-10-30T12:00:00Z');
    const ollama = (): ToolStatusItem => buildToolsStatus(readToolsSnapshot(paths, at)).tools.find((tool) => tool.id === 'ollama')!;
    expect(ollama()).toMatchObject({
      status: 'not-installed', installed: { version: null }, actions: ['install'], runActions: ['install'], installVersion: '0.40.13',
    });
    fs.writeFileSync(path.join(bin, 'ollama'), '#!/bin/sh\n');
    expect(ollama()).toMatchObject({ installed: { version: '0.40.6' }, runActions: ['update', 'requalify'], installVersion: null });
  });

  test('Ollama is offered its Re-check, then the recommended and the newest release (GitHub records digests)', () => {
    const bin = path.join(root, 'usr/local/bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'ollama'), '#!/bin/sh\n');
    paths = { ...paths, harnessBinDir: bin };
    for (const [file, text] of [[paths.toolctlPath, '#!/usr/bin/python3\n'], [paths.toolsUnitPaths[0], '[Unit]\n']]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    const at = Date.parse('2026-10-30T12:00:00Z');
    const ollama = (): ToolStatusItem => buildToolsStatus(readToolsSnapshot(paths, at)).tools.find((tool) => tool.id === 'ollama')!;
    expect(ollama()).toMatchObject({ status: 'not-checked', actions: ['requalify'], runActions: ['requalify'], restartsGateway: false });
    fs.mkdirSync(path.join(paths.stateRoot, 'admission'), { recursive: true });
    fs.writeFileSync(path.join(paths.stateRoot, 'admission', 'ollama.json'), JSON.stringify({
      schema: 'bridgesllm.tools.harness-admission.v1', version: '0.40.6', admittedAt: '2026-10-30T11:00:00.000Z', admittedBy: 'requalify:5d1f8a3c-6b72-4e19-8c40-7a2e9f0d3b12',
    }));
    expect(ollama()).toMatchObject({
      status: 'update-available', installed: { version: '0.40.6' }, actions: ['update-recommended'], runActions: ['update', 'requalify'],
    });
  });

  test('the service caches for 60 s, refreshes while a run is active, and is single-flight', async () => {
    let now = 1_000_000;
    let reads = 0;
    let active = false;
    const service = new ToolsStatusService({
      paths,
      nowMs: () => now,
      processAlive: () => true,
      readSnapshot: () => {
        reads += 1;
        return snapshot({ runs: active ? [run('queued') as any] : [] });
      },
    });
    const [first, second] = await Promise.all([service.get(), service.get()]);
    expect(reads).toBe(1);
    expect(second).toBe(first);
    now += 59_000;
    await service.get();
    expect(reads).toBe(1);
    now += 2_000;
    await service.get();
    expect(reads).toBe(2);
    await service.get(true);
    expect(reads).toBe(3);
    active = true;
    service.invalidate();
    await service.get();
    expect(reads).toBe(4);
    now += 3_500;
    await service.get();
    expect(reads).toBe(5);
  });
});

describe('a Re-check that read a version the Portal does not admit (F5)', () => {
  const unread = { version: null, admittedAt: null, admission: 'none' as const, source: null };
  const check = (tool: string, version: string | null, extra: Record<string, unknown> = {}) => run('refused', 'refused', {
    tool, error: { id: 'HARNESS_VERSION_NOT_ADMISSIBLE', message: `${version} is older than the Portal floor; update it instead.`, nextAction: 'update-recommended' },
    result: { action: 'requalify', from: null, to: null, ...(version ? { installedVersion: version } : {}) }, ...extra,
  });
  const item = (id: string, runs: unknown[], read: 'present' | 'ok' = 'present') => buildToolsStatus(snapshot({
    installed: { ...snapshot().installed, [id]: unread }, installedReads: { [id]: read }, runs: runs as any,
  })).tools.find((tool) => tool.id === id)!;

  test('below the floor the card shows the version read and offers the update, never only another Re-check', () => {
    expect(item('ollama', [])).toMatchObject({ status: 'not-checked', actions: ['requalify'] });
    expect(item('ollama', [check('ollama', '0.33.3')])).toMatchObject({
      status: 'below-floor', statusReason: 'Update required: Ollama 0.33.3 is older than the minimum 0.40.6.',
      installed: { version: '0.33.3', source: 'last-check', admission: 'none' },
      actions: ['update-recommended', 'requalify'], runActions: ['update', 'requalify'],
    });
    // Grok Build: only the Portal-tested version (no checksums, no "newest").
    expect(item('grok-build', [check('grok-build', '1.0.13')])).toMatchObject({
      status: 'below-floor', installed: { version: '1.0.13' }, actions: ['update-recommended', 'requalify'],
    });
    const summary = buildToolsStatus(snapshot({
      installed: { ...snapshot().installed, ollama: unread }, installedReads: { ollama: 'present' }, runs: [check('ollama', '0.33.3')] as any,
    })).summary;
    expect(summary).toMatchObject({ status: 'blocked', text: 'Ollama needs an update before it can be used.' });
  });

  test('the read stands through refusals that read nothing and ends at a newer read or any other finished run', () => {
    const refusedEarly = run('refused', 'refused', { tool: 'ollama', error: { id: 'HARNESS_FETCH_FAILED', message: 'x' }, result: { action: 'update', from: null, to: null } });
    expect(item('ollama', [refusedEarly, check('ollama', '0.33.3')])).toMatchObject({ status: 'below-floor', installed: { version: '0.33.3' } });
    expect(item('ollama', [check('ollama', null), check('ollama', '0.33.3')])).toMatchObject({ installed: { version: '0.33.3' } });
    // A newer read of an admitted version (refused for another reason) gives no verdict: Re-check again.
    const admitted = check('ollama', '0.40.6', { error: { id: 'HARNESS_SOURCE_UNVERIFIABLE', message: 'x', nextAction: null } });
    expect(item('ollama', [admitted, check('ollama', '0.33.3')])).toMatchObject({ status: 'not-checked', installed: { version: null } });
    expect(item('ollama', [admitted])).toMatchObject({ status: 'not-checked', actions: ['requalify'] });
    for (const state of ['succeeded', 'failed', 'rolled-back']) {
      const other = run(state, state, { tool: 'ollama', result: { action: 'update', from: '0.33.3', to: '0.40.13' } });
      expect(item('ollama', [other, check('ollama', '0.33.3')]).installed.version).toBeNull();
    }
    // An open run is not finished: the read still stands behind the "updating" card.
    expect(item('ollama', [run('queued', 'queued', { tool: 'ollama' }), check('ollama', '0.33.3')]))
      .toMatchObject({ status: 'updating', installed: { version: '0.33.3' } });
  });

  test('only a launcher without a cheap read uses it, and only below the floor or for a refused version', () => {
    // A version read from the package or a record always wins.
    expect(item('codex', [check('codex', '0.153.4')], 'ok')).toMatchObject({ installed: { version: null } });
    const policyWithDenied = policy();
    policyWithDenied.tools.find((tool) => tool.id === 'ollama')!.denylist = [{ version: '0.40.7', reason: 'it loses models' }];
    const denied = buildToolsStatus(snapshot({
      policy: policyWithDenied, installed: { ...snapshot().installed, ollama: unread }, installedReads: { ollama: 'present' },
      runs: [check('ollama', '0.40.7')] as any,
    })).tools.find((tool) => tool.id === 'ollama')!;
    expect(denied).toMatchObject({ status: 'blocked', installed: { version: '0.40.7' } });
    expect(denied.actions).toContain('update-recommended');
    // The policy floor moved below the read: no stale verdict.
    const lowered = policy();
    lowered.tools.find((tool) => tool.id === 'ollama')!.floor = '0.33.0';
    expect(buildToolsStatus(snapshot({
      policy: lowered, installed: { ...snapshot().installed, ollama: unread }, installedReads: { ollama: 'present' },
      runs: [check('ollama', '0.33.3')] as any,
    })).tools.find((tool) => tool.id === 'ollama')).toMatchObject({ status: 'not-checked', installed: { version: null } });
  });
});

describe('OpenClaw core update under the Portal-supervised gateway (K7)', () => {
  const live = { lockOwner: { runId: RUN_ID, pid: 4242, bootId: 'boot-1' } };

  test('the latest pre-flight says whether chat stays up until the switch-over or stops for the whole update', () => {
    const preflight = (updateMode: unknown, from = '2026.9.9') => ({
      ...run('succeeded'), endedAt: '2026-10-30T11:59:30.000Z',
      result: { action: 'preflight', from, to: from, preflight: 'preflight.json', updateMode },
    });
    const stopped = buildToolsStatus(snapshot({ runs: [preflight({ mode: 'stopped', reason: 'service-inspection' }) as any] }));
    expect(stopped.tools.find((tool) => tool.id === 'openclaw')?.updateMode)
      .toEqual({ mode: 'stopped', reason: 'service-inspection', checkedAt: '2026-10-30T11:59:30.000Z' });
    const liveMode = buildToolsStatus(snapshot({ runs: [preflight({ mode: 'live', reason: 'replacement-watcher' }) as any] }));
    expect(liveMode.tools.find((tool) => tool.id === 'openclaw')?.updateMode?.mode).toBe('live');
    for (const odd of [null, 'stopped', { mode: 'paused' }, { mode: 'stopped', reason: '<b>x</b>' }]) {
      const item = buildToolsStatus(snapshot({ runs: [preflight(odd) as any] })).tools.find((tool) => tool.id === 'openclaw');
      expect(item?.updateMode ?? null).toEqual(odd && typeof odd === 'object' && (odd as any).mode === 'stopped'
        ? { mode: 'stopped', reason: null, checkedAt: '2026-10-30T11:59:30.000Z' } : null);
    }
    expect(buildToolsStatus(snapshot()).tools.find((tool) => tool.id === 'openclaw')?.updateMode).toBeNull();
    // N2: the mode is the installed version's; a pre-flight of another version states none.
    const other = buildToolsStatus(snapshot({ runs: [preflight({ mode: 'live', reason: 'replacement-watcher' }, '2026.9.3') as any] }));
    expect(other.tools.find((tool) => tool.id === 'openclaw')?.updateMode).toBeNull();
  });

  test('a run names the Portal plugins it installed before OpenClaw refused (N4)', () => {
    const refused = (pluginsInstalled: unknown) => buildToolsStatus(snapshot({ runs: [{
      ...run('refused'), endedAt: '2026-10-30T11:59:30.000Z',
      error: { id: 'NATIVE_ADMISSION_REFUSED', message: 'refused', nextAction: null },
      result: { action: 'update', from: '2026.9.9', to: null, preflight: 'preflight.json', pluginsInstalled },
    } as any] })).tools.find((tool) => tool.id === 'openclaw')!.lastRun!;
    expect(refused(['bridgesllm-shared-browser 1.0.0']).pluginsInstalled).toEqual(['bridgesllm-shared-browser 1.0.0']);
    expect(refused([' ', 7, 'bridgesllm-ask-user 4.0.0']).pluginsInstalled).toEqual(['bridgesllm-ask-user 4.0.0']);
    for (const none of [undefined, [], 'bridgesllm-ask-user 4.0.0']) expect(refused(none)).not.toHaveProperty('pluginsInstalled');
  });

  test('the consent dialog knows when the installed version last passed a pre-flight (N2)', () => {
    const passedAt = (runs: unknown[]) => buildToolsStatus(snapshot({ runs: runs as any }))
      .tools.find((tool) => tool.id === 'openclaw')?.preflightPassedAt ?? null;
    const preflight = (state: string, from: string, action = 'preflight') => ({
      ...run(state), endedAt: '2026-10-30T11:59:30.000Z', result: { action, from, to: from, preflight: 'preflight.json' },
    });
    expect(passedAt([preflight('succeeded', '2026.9.9')])).toBe('2026-10-30T11:59:30.000Z');
    expect(passedAt([preflight('refused', '2026.9.9')])).toBeNull();
    expect(passedAt([preflight('succeeded', '2026.9.3')])).toBeNull();
    expect(passedAt([preflight('succeeded', '2026.9.9', 'update')])).toBeNull();
    expect(passedAt([])).toBeNull();
    // A later refusal replaces an earlier pass.
    expect(passedAt([{ ...preflight('refused', '2026.9.9'), runId: '1b6c2f1e-4a59-4d38-9d0e-2a7f5c1b9e02' },
      preflight('succeeded', '2026.9.9')])).toBeNull();
  });

  test('a version whose own updater refuses under the Portal is offered no update; its pre-flight stays (N3)', () => {
    const refused = (id: string, from: string, extra: Record<string, unknown> = {}) => ({
      ...run('refused'), endedAt: '2026-10-30T11:59:30.000Z',
      error: { id, message: 'refused', nextAction: null, refusals: [{ id, check: 'PF-11', message: 'refused' }] },
      result: { action: 'preflight', from, to: null, preflight: 'preflight.json' }, ...extra,
    });
    const openclaw = (runs: unknown[]) => buildToolsStatus(snapshot({ runs: runs as any })).tools.find((tool) => tool.id === 'openclaw')!;
    const plain = 'OpenClaw 2026.9.9 cannot update itself while the Portal runs it; it keeps working with this Portal; '
      + 'updating it from Maintenance needs a later Portal release.';
    for (const id of ['PF11_SELF_UPDATE_UNSUPPORTED', 'PF11_SERVICE_INSPECTION_UNAVAILABLE']) {
      const item = openclaw([refused(id, '2026.9.9')]);
      // Its own status: not an available update (nothing here can do it), and it keeps working.
      expect(item).toMatchObject({ status: 'needs-portal-release', statusReason: plain, actions: [] });
      expect(item.runActions).not.toContain('update');
      expect(item.runActions).toContain('preflight');
      const summary = buildToolsStatus(snapshot({ runs: [refused(id, '2026.9.9')] as any })).summary;
      expect(summary.text).not.toContain('Updates are available for OpenClaw');
      expect(summary.text).toContain('OpenClaw needs a later Portal release to update from Maintenance and keeps working until then.');
    }
    // Alone it is not "attention", and the summary never says every tool is up to date.
    expect(computeToolsSummary([
      { id: 'openclaw', label: 'OpenClaw', status: 'needs-portal-release' }, { id: 'codex', label: 'Codex', status: 'ok' },
    ] as ToolStatusItem[], null)).toEqual({
      status: 'ok',
      text: 'OpenClaw needs a later Portal release to update from Maintenance and keeps working until then. '
        + 'The other installed AI tools are up to date.',
      counts: { 'needs-portal-release': 1, ok: 1 },
    });
    expect(computeToolsSummary([
      { id: 'openclaw', label: 'OpenClaw', status: 'needs-portal-release' }, { id: 'codex', label: 'Codex', status: 'update-available' },
    ] as ToolStatusItem[], null).text).toBe('Updates are available for Codex. OpenClaw needs a later Portal release to update '
      + 'from Maintenance and keeps working until then.');
    // Below the minimum it stays required (the Portal does not use it), and the reason never says it keeps working.
    const below = buildToolsStatus(snapshot({
      installed: { openclaw: { version: '2026.8.30', admittedAt: '2026-10-30T11:00:00.000Z', admission: 'proven', source: null } },
      runs: [refused('PF11_SELF_UPDATE_UNSUPPORTED', '2026.8.30')] as any,
    })).tools.find((tool) => tool.id === 'openclaw')!;
    expect(below).toMatchObject({
      status: 'below-floor', actions: [],
      statusReason: 'Update required: OpenClaw 2026.8.30 is older than the minimum 2026.9.1. It cannot update itself while '
        + 'the Portal runs it; updating it from Maintenance needs a later Portal release.',
    });
    // A refused update run also recorded a mode: no mode line for an update not offered.
    const testRun = refused('PF11_SERVICE_INSPECTION_UNAVAILABLE', '2026.9.9', { result: {
      action: 'update', from: '2026.9.9', to: null, preflight: 'preflight.json',
      updateMode: { mode: 'stopped', reason: 'service-inspection', nativeReason: 'managed-service-preflight' } } });
    expect(openclaw([testRun])).toMatchObject({ statusReason: plain, actions: [], updateMode: null });
    // A refusal for an earlier version, another refusal, or a later passing pre-flight leaves the update offered.
    for (const runs of [[refused('PF11_SELF_UPDATE_UNSUPPORTED', '2026.9.8')], [refused('PF11_DRY_RUN_FAILED', '2026.9.9')],
      [{ ...run('succeeded'), createdAt: '2026-10-30T11:59:40.000Z', endedAt: '2026-10-30T11:59:50.000Z',
        result: { action: 'preflight', from: '2026.9.9', to: '2026.9.9', preflight: 'preflight.json' } },
      refused('PF11_SELF_UPDATE_UNSUPPORTED', '2026.9.9', { runId: '1b6c2f1e-4a59-4d38-9d0e-2a7f5c1b9e02' })]]) {
      const item = openclaw(runs);
      expect(item.actions).toEqual(['update-recommended', 'update-newest']);
      expect(item.runActions).toContain('update');
      expect(item.statusReason).not.toBe(plain);
      expect(item.status).toBe('update-available');
    }
  });

  describe('5.2.0 holds the OpenClaw core update for a later Portal release (openclaw.coreUpdates)', () => {
    const LATER = 'Updating OpenClaw from Maintenance comes in a later Portal release. OpenClaw keeps working; '
      + 'this Portal works with OpenClaw 2026.9.1 and newer.';
    const held = () => {
      const value = policy();
      value.openclaw.coreUpdates = 'later-release';
      return value;
    };
    const installedAt = (version: string) => ({ openclaw: { version, admittedAt: null, admission: 'none' as const, source: 'package-json' as const } });
    const statusOf = (overrides: Partial<ToolsSnapshot> = {}) => buildToolsStatus(snapshot({ policy: held(), ...overrides }));
    const openclawOf = (overrides: Partial<ToolsSnapshot> = {}) => statusOf(overrides).tools.find((tool) => tool.id === 'openclaw')!;
    const notApplied = {
      ...run('recovery-required'), endedAt: '2026-10-30T11:59:30.000Z',
      error: { id: 'UPDATE_NOT_APPLIED', nextAction: 'recover-native',
        message: 'OpenClaw stayed on 2026.9.9 and is running again, but its own update recovery is unfinished. Run OpenClaw repair.' },
      result: { action: 'update', from: '2026.9.9', to: '2026.9.9', preflight: 'preflight.json' },
    };

    test('the shipped policy holds it', () => {
      expect(JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8')).openclaw.coreUpdates).toBe('later-release');
    });

    test('every installed version needs a later Portal release, with no update, pre-flight or update mode', () => {
      const passed = { ...run('succeeded'), endedAt: '2026-10-30T11:59:30.000Z',
        result: { action: 'preflight', from: '2026.9.9', to: '2026.9.9', preflight: 'preflight.json', updateMode: { mode: 'live' } } };
      const failed = { ...run('rolled-back'), endedAt: '2026-10-30T11:59:30.000Z', error: { id: 'X', message: 'x', nextAction: null },
        result: { action: 'update', from: '2026.9.9', to: '2026.9.9' } };
      for (const [version, runs] of [['2026.9.1', []], ['2026.9.3', []], ['2026.9.9', [passed]], ['2026.9.9', [failed]],
        ['2026.10.9', []], ['2026.12.1', []]] as const) {
        const item = openclawOf({ installed: installedAt(version), runs: runs as any });
        expect(item).toMatchObject({ status: 'needs-portal-release', statusReason: LATER, actions: [], runActions: [],
          updateMode: null, preflightPassedAt: null, heldForLaterRelease: true });
      }
      // Codex and the other tools keep their own updates.
      expect(statusOf().tools.find((tool) => tool.id === 'codex')?.heldForLaterRelease).toBeUndefined();
    });

    test('below the minimum it stays required, in the same plain words', () => {
      expect(openclawOf({ installed: installedAt('2026.8.30') })).toMatchObject({
        status: 'below-floor', actions: [], runActions: [],
        statusReason: 'Update required: OpenClaw 2026.8.30 is older than the minimum 2026.9.1. Updating OpenClaw from '
          + 'Maintenance comes in a later Portal release.',
      });
    });

    test('the summary does not count it as an available update', () => {
      const status = statusOf({ installed: installedAt('2026.9.3') });
      expect(status.summary.text).not.toMatch(/Updates are available for[^.]*OpenClaw/);
      expect(status.summary.text).toContain('OpenClaw needs a later Portal release to update from Maintenance');
    });

    test('an update that was never applied closes with Retry checks; any other recovery keeps its repair', () => {
      const status = statusOf({ runs: [notApplied as any] });
      expect(status.recovery).toMatchObject({ title: 'OpenClaw was not updated and is running again.', action: { id: 'retry-checks' },
        tool: 'openclaw', detail: expect.stringContaining('OpenClaw 2026.9.9 never changed') });
      const item = status.tools.find((tool) => tool.id === 'openclaw')!;
      expect(item).toMatchObject({ status: 'recovery-required', runActions: ['retry-checks'] });
      expect(item.lastRun).toMatchObject({ nextAction: 'retry-checks', message: status.recovery!.detail });
      expect(status.summary.text).toBe('OpenClaw was not updated and is running again. Retry checks to continue.');
      // The package changed since (or the record says it did): the repair stays the one action.
      for (const result of [{ from: '2026.9.8', to: '2026.9.8' }, { from: '2026.9.9', to: '2026.10.9' }]) {
        const changed = statusOf({ runs: [{ ...notApplied, result: { action: 'update', ...result } }] as any });
        expect(changed.recovery?.action.id).toBe('recover-native');
        expect(changed.tools.find((tool) => tool.id === 'openclaw')?.runActions).toEqual(['recover-native']);
      }
      // A refused run changed nothing: it does not hide the recovery.
      const refused = { ...run('refused'), runId: '1b6c2f1e-4a59-4d38-9d0e-2a7f5c1b9e02', createdAt: '2026-10-30T11:59:50.000Z',
        error: { id: 'PF4_TOOLS_RUN_ACTIVE', message: 'busy', nextAction: null }, result: { action: 'retry-checks', from: '2026.9.9', to: null } };
      expect(statusOf({ runs: [refused, notApplied] as any }).recovery?.action.id).toBe('retry-checks');
      // Without the flag the same recovery is repaired, as before.
      expect(buildToolsStatus(snapshot({ runs: [notApplied as any] })).recovery?.action.id).toBe('recover-native');
    });
  });

  test('a run holding the gateway stopped says chat is unavailable, and its gateway steps cannot be stopped', () => {
    const parked = buildToolsStatus(snapshot({
      runs: [{ ...run('native'), state: 'running', native: { phase: 'validating' }, gateway: { stoppedByToolctl: true },
        steps: [{ id: 'gateway-stop', label: 'Stopping the OpenClaw gateway', state: 'passed' },
          { id: 'native', label: 'OpenClaw is updating', state: 'running' }] } as any],
      ...live,
    }), { processAlive: () => true });
    const item = parked.tools.find((tool) => tool.id === 'openclaw');
    expect(item?.statusReason).toBe("OpenClaw's gateway is stopped while the update finishes. Chat is unavailable until it "
      + 'starts again; this page keeps checking.');
    for (const step of ['gateway-stop', 'native-repair', 'gateway-start', 'rollback']) {
      const busy = buildToolsStatus(snapshot({
        runs: [{ ...run('native'), state: 'running', steps: [{ id: step, label: step, state: 'running' }] } as any], ...live,
      }), { processAlive: () => true });
      expect(busy.activeRun?.stopRefusal).toMatch(/OpenClaw/);
    }
    const up = buildToolsStatus(snapshot({
      runs: [{ ...run('native'), state: 'running', native: { phase: 'validating' }, gateway: { stoppedByToolctl: false } } as any],
      ...live,
    }), { processAlive: () => true });
    expect(up.tools.find((tool) => tool.id === 'openclaw')?.statusReason).toBe('An update is running.');
    expect(up.activeRun?.stopRefusal).toBeNull();
  });
});
