// @vitest-environment jsdom
import '../../test/setup';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AiToolsPanel from './AiToolsPanel';
import AiToolsRunProgress from './AiToolsRunProgress';
import AiToolRunResult from './AiToolRunResult';
import { openclawItem, toolItem, toolsStatus } from './toolsFixtures';
import type { ToolLastRun } from '../../api/maintenanceTools';

const api = vi.hoisted(() => ({ getStatus: vi.fn(), startRun: vi.fn() }));

vi.mock('../../api/maintenanceTools', () => ({
  maintenanceToolsAPI: { getStatus: api.getStatus, startRun: api.startRun },
}));

function lastRun(overrides: Partial<ToolLastRun> = {}): ToolLastRun {
  return {
    runId: 'r1', action: 'update', state: 'succeeded', startedAt: '2026-10-30T11:00:00.000Z', endedAt: '2026-10-30T11:40:00.000Z',
    errorId: null, message: null, nextAction: null, from: '2026.9.9', to: '2026.10.9', refusals: [], ...overrides,
  };
}

describe('AI tools progress', () => {
  it('shows the steps, the live native phase, elapsed time and that leaving is safe', () => {
    render(
      <AiToolsRunProgress
        toolLabel="OpenClaw"
        nowMs={Date.parse('2026-10-30T12:07:30.000Z')}
        run={{
          runId: 'r1', tool: 'openclaw', phase: 'native', state: 'running', startedAt: '2026-10-30T12:00:00.000Z', stale: false,
          nativePhase: 'validating', gatewayRestarting: false,
          steps: [
            { id: 'preflight', label: 'Checking…', state: 'passed', startedAt: null, endedAt: null, detail: 'All available checks passed.', evidence: [] },
            { id: 'native', label: 'OpenClaw is updating', state: 'running', startedAt: null, endedAt: null, detail: null, evidence: [] },
          ],
        }}
      />,
    );
    expect(screen.getByRole('heading', { name: 'OpenClaw: OpenClaw is updating (validating it on a copy)' })).toBeInTheDocument();
    expect(screen.getByText(/Running for 7 min 30 s\. It is safe to leave this page; the update continues on the server\./)).toBeInTheDocument();
    const steps = within(screen.getByRole('list', { name: 'Update steps' })).getAllByRole('listitem');
    expect(steps.map((step) => step.textContent)).toEqual([
      'Checking…— doneAll available checks passed.',
      'OpenClaw is updating— in progress',
    ]);
    expect(screen.queryByText(/Chats pause/)).toBeNull();
  });

  it('says chats pause during the OpenClaw restart window', () => {
    render(
      <AiToolsRunProgress toolLabel="OpenClaw" run={{
        runId: 'r1', tool: 'openclaw', phase: 'plugins-post', state: 'verifying', startedAt: null, stale: false,
        nativePhase: null, gatewayRestarting: true, steps: [],
      }} />,
    );
    expect(screen.getByRole('heading', { name: 'OpenClaw: Reconnecting Portal plugins' })).toBeInTheDocument();
    expect(screen.getByText('OpenClaw\'s gateway is stopped or restarting, so chat is unavailable until it is back; this page keeps checking.'))
      .toBeInTheDocument();
    expect(screen.queryByText(/few minutes/)).toBeNull();
  });

  it('a check that could not read its answer reads "not confirmed", never the raw state', () => {
    render(
      <AiToolsRunProgress toolLabel="OpenClaw" run={{
        runId: 'r1', tool: 'openclaw', phase: 'verify', state: 'verifying', startedAt: null, stale: false,
        nativePhase: null, gatewayRestarting: false,
        steps: [
          { id: 'contract', label: 'Checking chat features', state: 'unproven', startedAt: null, endedAt: null,
            detail: "config.get's reply exceeded 16777216 bytes", evidence: [] },
          { id: 'optional', label: 'Optional checks', state: 'not-run', startedAt: null, endedAt: null, detail: null, evidence: [] },
        ],
      }} />,
    );
    const steps = within(screen.getByRole('list', { name: 'Update steps' })).getAllByRole('listitem');
    expect(steps.map((step) => step.textContent)).toEqual([
      "Checking chat features— not confirmedconfig.get's reply exceeded 16777216 bytes",
      'Optional checks— not run',
    ]);
  });

  it('an install reads as an installation, Stop included', () => {
    render(
      <AiToolsRunProgress toolLabel="Codex CLI" owner onStop={() => undefined} run={{
        runId: 'r1', tool: 'codex', phase: 'fetch', state: 'running', startedAt: null, stale: false,
        nativePhase: null, gatewayRestarting: false, steps: [], action: 'install',
      }} />,
    );
    expect(screen.getByText('It is safe to leave this page; the installation continues on the server.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop this installation' })).toBeInTheDocument();
  });
});

describe('AI tools results', () => {
  const noop = () => undefined;

  it('Updated: from → to', () => {
    render(<AiToolRunResult tool={openclawItem({ lastRun: lastRun() })} owner busy={false} onNextAction={noop} />);
    expect(screen.getByRole('group', { name: 'Last OpenClaw run' })).toHaveTextContent('Updated: 2026.9.9 → 2026.10.9.All required checks passed.');
  });

  it('Not updated: every refusal reason, a button only for an accepted next action, text otherwise', async () => {
    const onNextAction = vi.fn();
    const tool = openclawItem({
      lastRun: lastRun({
        state: 'refused', to: null, errorId: 'PF7_NODE', message: 'Node.js 24.21.0 must be updated to satisfy OpenClaw 2026.10.9.',
        nextAction: 'node-runtime',
        refusals: [
          { id: 'PF7_NODE', check: 'PF-7', message: 'Node.js 24.21.0 must be updated to satisfy OpenClaw 2026.10.9.', nextAction: 'node-runtime' },
          { id: 'PF8_DISK', check: 'PF-8', message: 'Needs 49 GB free on /, has 19 GB.', nextAction: 'free-disk' },
        ],
      }),
    });
    render(<AiToolRunResult tool={tool} owner busy={false} onNextAction={onNextAction} />);
    const group = screen.getByRole('group', { name: 'Last OpenClaw run' });
    expect(group).toHaveTextContent('Not updated. Nothing was changed.');
    expect(within(group).getByRole('list', { name: 'Other reasons' })).toHaveTextContent(
      'Needs 49 GB free on /, has 19 GB. Free disk space on the server, then try again.',
    );
    await userEvent.setup().click(within(group).getByRole('button', { name: 'Review the update with Node.js' }));
    expect(onNextAction).toHaveBeenCalledWith('node-runtime');
  });

  it('a refused Re-check or pre-flight is titled by what it is, never "Not updated" (F9)', () => {
    // Fresh results: an older refusal also says how old it is (its own test, AiToolsLabels).
    const view = (run: Parameters<typeof lastRun>[0]) => {
      const { unmount } = render(<AiToolRunResult tool={openclawItem({ lastRun: lastRun({ endedAt: new Date().toISOString(), ...run }) })}
        owner busy={false} onNextAction={noop} />);
      const text = screen.getByRole('group', { name: 'Last OpenClaw run' }).textContent;
      unmount();
      return text;
    };
    const reason = 'The OpenClaw update dry run failed: managed service ownership cannot be verified.';
    expect(view({ action: 'preflight', state: 'refused', to: null, errorId: 'PF11_DRY_RUN_FAILED', message: reason }))
      .toBe(`Pre-flight refused — ${reason}Nothing was changed.`);
    expect(view({ action: 'requalify', state: 'refused', from: null, to: null, errorId: 'HARNESS_VERSION_NOT_ADMISSIBLE',
      message: 'Ollama 0.33.3 is older than the Portal floor 0.40.6; update it instead.' }))
      .toBe('Checked — Ollama 0.33.3 is older than the Portal floor 0.40.6; update it instead.Nothing was changed.');
    expect(view({ action: 'requalify', state: 'refused', from: null, to: null, message: null }))
      .toBe('Checked — OpenClaw was not confirmed.Nothing was changed.');
    expect(view({ action: 'requalify', state: 'succeeded', from: '0.166.0', to: '0.166.0' })).toBe('Checked — OpenClaw 0.166.0 is confirmed.');
    expect(view({ action: 'update', state: 'refused', to: null, message: reason })).toBe(`Not updated. Nothing was changed.${reason}`);
  });

  it('a next action the API does not accept is shown as an instruction, never as a button', () => {
    render(<AiToolRunResult
      tool={openclawItem({ runActions: [], lastRun: lastRun({ state: 'succeeded-degraded', message: 'Chat is unavailable: OC-PLUG-ASK failed.', nextAction: 'retry-checks' }) })}
      owner busy={false} onNextAction={noop} />);
    const group = screen.getByRole('group', { name: 'Last OpenClaw run' });
    expect(group).toHaveTextContent('Updated: 2026.9.9 → 2026.10.9, but some checks did not pass.Chat is unavailable: OC-PLUG-ASK failed.');
    expect(within(group).queryByRole('button')).toBeNull();
    expect(group).toHaveTextContent('Next step: Run the Portal feature checks again.');
  });

  it('a free-text next action from OpenClaw is shown verbatim', () => {
    render(<AiToolRunResult
      tool={openclawItem({ lastRun: lastRun({ state: 'refused', message: 'Would refuse update: config schema.', nextAction: 'Run openclaw doctor --fix, then retry.' }) })}
      owner busy={false} onNextAction={noop} />);
    expect(screen.getByRole('group', { name: 'Last OpenClaw run' })).toHaveTextContent('Next step: Run openclaw doctor --fix, then retry.');
  });

  it('Rolled back and Recovery required read plainly', () => {
    const { unmount } = render(<AiToolRunResult
      tool={openclawItem({ lastRun: lastRun({ state: 'rolled-back', to: null, message: 'gateway readiness check failed' }) })}
      owner busy={false} onNextAction={noop} />);
    expect(screen.getByRole('group', { name: 'Last OpenClaw run' })).toHaveTextContent(
      'Update failed; OpenClaw automatically returned to 2026.9.9.Reason: gateway readiness check failed',
    );
    unmount();
    render(<AiToolRunResult
      tool={openclawItem({ runActions: ['recover-native'], lastRun: lastRun({ state: 'recovery-required', message: 'Rollback could not be verified.', nextAction: 'recover-native' }) })}
      owner busy={false} onNextAction={noop} />);
    const group = screen.getByRole('group', { name: 'Last OpenClaw run' });
    expect(group).toHaveTextContent('OpenClaw needs recovery. Chat may be unavailable.');
    expect(within(group).getByRole('button', { name: 'Run OpenClaw repair' })).toBeEnabled();
  });

  it('admins see the instruction instead of the button', () => {
    render(<AiToolRunResult
      tool={openclawItem({ lastRun: lastRun({ state: 'succeeded-degraded', message: 'Chat is unavailable.', nextAction: 'retry-checks' }) })}
      owner={false} busy={false} onNextAction={noop} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Next step: Run the Portal feature checks again.')).toBeInTheDocument();
  });
});

describe('AI tools panel next actions', () => {
  beforeEach(() => {
    api.getStatus.mockReset();
    api.startRun.mockReset();
    api.startRun.mockResolvedValue({ runId: 'r2' });
  });

  it('shows live progress for the active run and no update buttons meanwhile', async () => {
    api.getStatus.mockResolvedValue(toolsStatus({
      activeRun: { runId: 'r1', tool: 'openclaw', phase: 'preflight', state: 'preflight', startedAt: null, steps: [], nativePhase: null, gatewayRestarting: false, stale: false },
      tools: [openclawItem({ status: 'updating', statusReason: 'Checking…', actions: [], runActions: [] }), toolItem({ actions: [], runActions: [] })],
    }));
    render(<AiToolsPanel owner />);
    expect(await screen.findByRole('heading', { name: 'OpenClaw: Checking…' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Update/ })).toBeNull();
  });

  it('Retry checks and the Node.js review are started from the result panel', async () => {
    api.getStatus.mockResolvedValue(toolsStatus({
      tools: [
        openclawItem({ lastRun: lastRun({ state: 'succeeded-degraded', message: 'Chat is unavailable: OC-PLUG-ASK failed.', nextAction: 'retry-checks' }) }),
        toolItem(),
      ],
    }));
    const user = userEvent.setup();
    render(<AiToolsPanel owner />);
    await user.click(await screen.findByRole('button', { name: 'Retry checks' }));
    expect(api.startRun).toHaveBeenCalledWith({ tool: 'openclaw', action: 'retry-checks' });
  });

  it('a degraded OpenClaw keeps Retry checks on its card after a later pre-flight, and never shows it twice', async () => {
    const degraded = { status: 'degraded' as const, statusReason: 'Chat is unavailable: OC-PLUG-ASK failed.' };
    api.getStatus.mockResolvedValue(toolsStatus({
      tools: [openclawItem({ ...degraded, lastRun: lastRun({ action: 'preflight', state: 'succeeded', from: '2026.10.9', to: '2026.10.9' }) }), toolItem()],
    }));
    const user = userEvent.setup();
    const { unmount } = render(<AiToolsPanel owner />);
    expect(await screen.findByText('Pre-flight passed — OpenClaw can update.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry checks' }));
    expect(api.startRun).toHaveBeenCalledWith({ tool: 'openclaw', action: 'retry-checks' });
    unmount();
    api.getStatus.mockResolvedValue(toolsStatus({
      tools: [openclawItem({ ...degraded, lastRun: lastRun({ state: 'succeeded-degraded', message: degraded.statusReason, nextAction: 'retry-checks' }) }), toolItem()],
    }));
    render(<AiToolsPanel owner />);
    expect(await screen.findAllByRole('button', { name: 'Retry checks' })).toHaveLength(1);
  });
});
