// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AiToolCard from './AiToolCard';
import AiToolsPanel from './AiToolsPanel';
import AiToolsRunProgress, { runPhaseLabel } from './AiToolsRunProgress';
import AiToolRunResult, { refusalAge } from './AiToolRunResult';
import { admissionBadge, checksDetailLine, newestLine, stepDetailText, toolImpactLine } from './toolsPresentation';
import { activeRun, lastRun, notCheckedItem, openclawItem, runStep, toolItem, toolsStatus } from './toolsFixtures';

const api = vi.hoisted(() => ({ getStatus: vi.fn(), startRun: vi.fn(), stopRun: vi.fn() }));

vi.mock('../../api/maintenanceTools', () => ({
  maintenanceToolsAPI: { getStatus: api.getStatus, startRun: api.startRun, stopRun: api.stopRun },
}));

/** Every updater state a card can be in has one plain label. */
describe('AI tools state labels', () => {
  beforeEach(() => {
    api.getStatus.mockReset();
    api.startRun.mockReset();
    api.startRun.mockResolvedValue({ runId: 'r1' });
    api.stopRun.mockReset();
    api.stopRun.mockResolvedValue({ runId: 'r1', stopping: true });
  });

  it('a launcher nothing has read yet is "Not checked yet" (never "Checking") and offers only its Re-check', () => {
    const onRequest = vi.fn();
    render(<AiToolCard tool={notCheckedItem()} owner busy={false} onRequest={onRequest} onNextAction={vi.fn()} />);
    const card = screen.getByRole('article', { name: 'Grok Build' });
    expect(within(card).getByTestId('ai-tool-grok-build-chip')).toHaveTextContent(/^Not checked yet$/);
    expect(within(card).queryByText('Checking')).toBeNull();
    const buttons = within(card).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['Re-check Grok Build']);
    buttons[0].click();
    expect(onRequest).toHaveBeenCalledWith({ kind: 'requalify', tool: expect.objectContaining({ id: 'grok-build' }) });
  });

  it('a tool this release updates only to its qualified version says "newest" is not offered, with no newest button', () => {
    const harness = toolItem({ id: 'opencode', label: 'OpenCode', actions: ['update-recommended'], newestNotOffered: true });
    render(<AiToolCard tool={harness} owner busy={false} onRequest={vi.fn()} onNextAction={vi.fn()} />);
    const card = screen.getByRole('article', { name: 'OpenCode' });
    expect(within(card).getByTestId('ai-tool-opencode-newest')).toHaveTextContent(/^Not offered from Maintenance in this release$/);
    expect(within(card).queryByRole('button', { name: /to newest/ })).toBeNull();
    expect(newestLine({ newest: { version: '1.20.0', checkedAt: null }, newestNotOffered: true }))
      .toBe('1.20.0 is not offered from Maintenance in this release');
    // The npm CLIs keep their "newest" choice and wording.
    expect(newestLine({ newest: { version: null, checkedAt: null } })).toBe('not checked yet');
    expect(newestLine({ newest: { version: '0.170.0', checkedAt: null } })).toBe('0.170.0');
  });

  it('a current card offers the Re-check the API offers, as a choice beside "newest" (N6)', () => {
    const onRequest = vi.fn();
    const current = toolItem({ actions: ['update-newest', 'requalify'] });
    const { rerender } = render(<AiToolCard tool={current} owner busy={false} onRequest={onRequest} onNextAction={vi.fn()} />);
    const card = screen.getByRole('article', { name: 'Codex CLI' });
    expect(within(card).getByTestId('ai-tool-codex-chip')).toHaveTextContent(/^Current$/);
    const recheck = within(card).getByRole('button', { name: 'Re-check Codex CLI' });
    expect(recheck.className).toBe(within(card).getByRole('button', { name: 'Update Codex CLI to newest' }).className);
    recheck.click();
    expect(onRequest).toHaveBeenCalledWith({ kind: 'requalify', tool: expect.objectContaining({ id: 'codex' }) });
    // Antigravity newer than tested: only its Re-check; a recovery still offers nothing (P7).
    rerender(<AiToolCard tool={toolItem({ id: 'antigravity', label: 'Antigravity', newerThanTested: true, actions: ['requalify'] })}
      owner busy={false} onRequest={onRequest} onNextAction={vi.fn()} />);
    expect(within(screen.getByRole('article', { name: 'Antigravity' })).getAllByRole('button').map((b) => b.textContent))
      .toEqual(['Re-check Antigravity']);
    rerender(<AiToolCard tool={current} owner busy={false} recoveryOpen onRequest={onRequest} onNextAction={vi.fn()} />);
    expect(within(screen.getByRole('article', { name: 'Codex CLI' })).queryAllByRole('button')).toEqual([]);
  });

  it('an OpenClaw that cannot update itself under the Portal has its own chip, its reason and only the pre-flight (N3)', () => {
    const reason = 'OpenClaw 2026.9.3 cannot update itself while the Portal runs it; it keeps working with this Portal; '
      + 'updating it from Maintenance needs a later Portal release.';
    render(<AiToolCard tool={openclawItem({
      status: 'needs-portal-release', statusReason: reason, actions: [], runActions: ['preflight', 'retry-checks'],
      installed: { version: '2026.9.3', admittedAt: null, admission: 'none', source: 'package-json' },
    })} owner busy={false} onRequest={vi.fn()} onNextAction={vi.fn()} />);
    const card = screen.getByRole('article', { name: 'OpenClaw' });
    expect(within(card).getByTestId('ai-tool-openclaw-chip')).toHaveTextContent(/^Needs a later Portal release$/);
    expect(within(card).queryByText('Update available')).toBeNull();
    expect(within(card).getByText(reason)).toBeInTheDocument();
    expect(within(card).getAllByRole('button').map((button) => button.textContent)).toEqual(['Check whether OpenClaw can update']);
  });

  it('5.2.0 holds the OpenClaw core update: its own chip and sentence, no button and no restart line', () => {
    const later = 'Updating OpenClaw from Maintenance comes in a later Portal release. OpenClaw keeps working; '
      + 'this Portal works with OpenClaw 2026.9.1 and newer.';
    const { rerender } = render(<AiToolCard tool={openclawItem({
      status: 'needs-portal-release', statusReason: later, actions: [], runActions: [], heldForLaterRelease: true,
      installed: { version: '2026.10.6', admittedAt: null, admission: 'none', source: 'package-json' },
    })} owner busy={false} onRequest={vi.fn()} onNextAction={vi.fn()} />);
    const card = () => screen.getByRole('article', { name: 'OpenClaw' });
    expect(within(card()).getByTestId('ai-tool-openclaw-chip')).toHaveTextContent(/^Needs a later Portal release$/);
    expect(within(card()).getByText(later)).toBeInTheDocument();
    expect(within(card()).queryAllByRole('button')).toEqual([]);
    expect(within(card()).queryByText(/Restarts OpenClaw|chat pauses|up to 2 hours/)).toBeNull();
    // Below the minimum (held): still no restart line for an update nothing here can run.
    rerender(<AiToolCard tool={openclawItem({ status: 'below-floor', statusReason: 'Update required.', actions: [], runActions: [],
      heldForLaterRelease: true })} owner busy={false} onRequest={vi.fn()} onNextAction={vi.fn()} />);
    expect(within(card()).queryByText(/Restarts OpenClaw|chat pauses|up to 2 hours/)).toBeNull();
    // An OpenClaw update that can run still says what it does.
    rerender(<AiToolCard tool={openclawItem()} owner busy={false} onRequest={vi.fn()} onNextAction={vi.fn()} />);
    expect(within(card()).getByText(/up to 2 hours/)).toBeInTheDocument();
  });

  it('an update that was never applied and a passing Retry checks say what happened, never "Updated"', () => {
    const notApplied = openclawItem({ status: 'recovery-required', runActions: ['retry-checks'], lastRun: lastRun({
      action: 'update', state: 'recovery-required', errorId: 'UPDATE_NOT_APPLIED', nextAction: 'retry-checks', from: '2026.10.6',
      to: '2026.10.6', message: 'OpenClaw 2026.10.6 never changed.' }) });
    const onNextAction = vi.fn();
    const { rerender } = render(<AiToolRunResult tool={notApplied} owner busy={false} onNextAction={onNextAction} />);
    const result = () => screen.getByTestId('ai-tool-openclaw-result');
    expect(within(result()).getByText('Not updated; OpenClaw 2026.10.6 is running again.')).toBeInTheDocument();
    within(result()).getByRole('button', { name: 'Retry checks' }).click();
    expect(onNextAction).toHaveBeenCalledWith('retry-checks');
    rerender(<AiToolRunResult tool={openclawItem({ lastRun: lastRun({ action: 'retry-checks', state: 'succeeded', from: '2026.10.6',
      to: '2026.10.6', message: null, nextAction: null, errorId: null }) })} owner busy={false} onNextAction={vi.fn()} />);
    expect(result()).toHaveTextContent('Checks passed — OpenClaw 2026.10.6 answers every required Portal check.');
    expect(result()).not.toHaveTextContent(/Updated/);
  });

  it('a tool that is gone shows no earlier success as current', () => {
    const gone = (run: Parameters<typeof lastRun>[0]) => toolItem({ id: 'clawhub', label: 'ClawHub', status: 'not-installed',
      statusReason: 'Not installed on this server.', installed: { version: null, admittedAt: null, admission: 'none', source: null },
      lastRun: lastRun(run) });
    for (const action of ['requalify', 'install', 'update']) {
      const { unmount } = render(<AiToolRunResult tool={gone({ action, state: 'succeeded', to: '0.24.1', from: '0.24.1' })}
        owner busy={false} onNextAction={vi.fn()} />);
      expect(screen.queryByTestId('ai-tool-clawhub-result')).toBeNull();
      expect(screen.queryByText(/is confirmed|Installed ClawHub/)).toBeNull();
      unmount();
    }
    // A failed install of the missing tool still says why.
    render(<AiToolRunResult tool={gone({ action: 'install', state: 'rolled-back', message: 'checks failed' })} owner busy={false}
      onNextAction={vi.fn()} />);
    expect(screen.getByTestId('ai-tool-clawhub-result')).toHaveTextContent('Install failed');
  });

  it('a Re-check that read a version below the floor leaves "Update required" with the update, not only a Re-check (F5)', () => {
    const onRequest = vi.fn();
    const tool = notCheckedItem({
      installed: { version: '1.0.13', admittedAt: null, admission: 'none', source: 'last-check' },
      status: 'below-floor', statusReason: 'Update required: Grok Build 1.0.13 is older than the minimum 1.0.62.',
      actions: ['update-recommended', 'requalify'], runActions: ['update', 'requalify'],
    });
    render(<AiToolCard tool={tool} owner busy={false} onRequest={onRequest} onNextAction={vi.fn()} />);
    const card = screen.getByRole('article', { name: 'Grok Build' });
    expect(within(card).getByTestId('ai-tool-grok-build-chip')).toHaveTextContent(/^Update required$/);
    expect(within(card).getByText(/^Installed 1\.0\.13/)).toBeInTheDocument();
    expect(within(card).getByText(/Source: read by the last Re-check/)).toBeInTheDocument();
    expect(within(card).getAllByRole('button').map((button) => button.textContent))
      .toEqual(expect.arrayContaining(['Update Grok Build to 1.0.62', 'Re-check Grok Build']));
  });

  it('a probe that is not required here reads "Not needed here" with its reason', () => {
    render(<AiToolsRunProgress toolLabel="Codex CLI" run={activeRun({
      steps: [runStep({ detail: 'C-VER, C-HEADLESS passed; not required here: C-APP.' })],
    })} />);
    expect(screen.getByText('C-VER, C-HEADLESS passed. Not needed here: C-APP (OpenClaw uses its own Codex).')).toBeInTheDocument();
    expect(screen.queryByText(/not required here/)).toBeNull();
    // The candidate/installed suffix stays; a probe id with no known reason gets no invented one.
    expect(stepDetailText('C-VER passed; not required here: C-APP. (candidate)'))
      .toBe('C-VER passed. Not needed here: C-APP (OpenClaw uses its own Codex). (candidate)');
    expect(stepDetailText('C-VER passed; not required here: C-NEW.')).toBe('C-VER passed. Not needed here: C-NEW.');
    expect(stepDetailText('The installed files are the official release.')).toBe('The installed files are the official release.');
  });

  it('the OpenClaw result Details list features off, a missing required method and whether gateway methods were checked', () => {
    const degraded = openclawItem({
      status: 'ok',
      installed: { version: '2026.10.9', admittedAt: null, admission: 'none', source: 'package-json' },
      lastRun: lastRun({
        state: 'succeeded-degraded',
        errorId: 'CONTRACT_REQUIRED_PROBE_FAILED',
        message: 'Chat is unavailable: OpenClaw doesn\'t offer chat.send.',
        nextAction: 'retry-checks',
        contract: {
          featuresOff: { goals: ['sessions.goal.update', 'sessions.goal.clear'], 'native questions': ['question.list'] },
          missingMethods: ['chat.send'],
          methods: { state: 'failed', reason: null },
        },
      }),
    });
    const { unmount } = render(<AiToolCard tool={degraded} owner busy={false} onRequest={vi.fn()} onNextAction={vi.fn()} />);
    expect(within(screen.getByTestId('ai-tool-openclaw-result')).getByText(/chat\.send/)).toBeInTheDocument();
    const checks = screen.getByRole('list', { name: 'Portal feature checks' });
    expect(within(checks).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Off: goals (sessions.goal.update, sessions.goal.clear not offered)',
      'Off: native questions (question.list not offered)',
      'Missing required method: chat.send',
      'Gateway methods: checked',
    ]);
    unmount();
    const reason = 'The Portal backend hasn\'t reconnected to OpenClaw since this run\'s restart window opened, so OpenClaw\'s method list wasn\'t checked.';
    render(<AiToolCard tool={openclawItem({ lastRun: lastRun({ contract: { featuresOff: {}, missingMethods: [], methods: { state: 'not-run', reason } } }) })}
      owner busy={false} onRequest={vi.fn()} onNextAction={vi.fn()} />);
    expect(within(screen.getByRole('list', { name: 'Portal feature checks' })).getAllByRole('listitem').map((item) => item.textContent))
      .toEqual([`Gateway methods: not checked — ${reason}`]);
  });

  it('Details never say "none recorded yet" right after checks passed', () => {
    const checksLine = (tool: Parameters<typeof checksDetailLine>[0]) => {
      const { unmount } = render(<AiToolCard tool={{ ...toolItem(), ...tool }} owner busy={false} onRequest={vi.fn()} onNextAction={vi.fn()} />);
      const line = screen.getByText(/^Checks/).textContent;
      expect(screen.queryByText(/none recorded yet/)).toBeNull();
      unmount();
      return line;
    };
    expect(checksLine({ capabilities: toolItem().capabilities, lastRun: lastRun() }))
      .toBe('Checks: all required checks passed in the last run.');
    expect(checksLine({ capabilities: toolItem().capabilities, lastRun: lastRun({ action: 'preflight' }) }))
      .toBe('Checks: the last pre-flight passed.');
    for (const state of ['refused', 'failed', 'succeeded-degraded', 'rolled-back']) {
      expect(checksLine({ capabilities: toolItem().capabilities, lastRun: lastRun({ state }) })).toBe('Checks: see the last run above.');
    }
    expect(checksLine({ capabilities: toolItem().capabilities, lastRun: null })).toBe('Checks: none run yet.');
    // A recorded list is shown as it is.
    expect(checksLine({ capabilities: { required: { passed: ['C-VER'], failed: ['C-APP'] }, optionalOff: [] }, lastRun: null }))
      .toBe('Checks passed: C-VER · failed: C-APP');
  });

  it('a re-check record that did not compare the bytes says so on the badge', () => {
    const requalified = (id: string, label: string, authority: string | null, bytesVerified: boolean | null) => toolItem({
      id, label, category: 'harness',
      installed: { version: '1.0.70', admittedAt: '2026-10-30T11:00:00.000Z', admission: 'requalified', source: 'admission-record', authority, bytesVerified },
    });
    const { unmount } = render(<AiToolCard tool={requalified('grok-build', 'Grok Build', 'vendor-self-update', false)} owner busy={false} onRequest={vi.fn()} onNextAction={vi.fn()} />);
    expect(screen.getByText('Re-checked by its probes; the vendor publishes no checksum')).toBeInTheDocument();
    expect(screen.queryByText('Re-qualified')).toBeNull();
    unmount();
    render(<AiToolCard tool={requalified('hermes', 'Hermes', 'github-tag-commit', false)} owner busy={false} onRequest={vi.fn()} onNextAction={vi.fn()} />);
    expect(screen.getByText('Re-checked; the installed files were compared, not downloaded')).toBeInTheDocument();
    // Antigravity at its pinned version (probes only), Ollama's re-check (GitHub digest record), and byte-verified records.
    expect(admissionBadge(requalified('antigravity', 'Antigravity', 'probes-only', false).installed)).toBe('Re-checked by its probes; the vendor publishes no checksum');
    expect(admissionBadge(requalified('ollama', 'Ollama', 'github-asset-digest', false).installed))
      .toBe('Re-checked by its probes; its files were not compared with the official download');
    render(<AiToolCard tool={requalified('ollama', 'Ollama', 'github-asset-digest', false)} owner busy={false} onRequest={vi.fn()} onNextAction={vi.fn()} />);
    expect(screen.getByText('Re-checked by its probes; its files were not compared with the official download')).toBeInTheDocument();
    expect(admissionBadge(requalified('hermes', 'Hermes', 'github-tag-commit', true).installed)).toBe('Re-qualified');
    expect(admissionBadge(requalified('codex', 'Codex CLI', null, null).installed)).toBe('Re-qualified');
  });

  it('each update confirm says what it does: Ollama restarts its server, Hermes builds alongside, others no OpenClaw restart', async () => {
    const harness = (id: string, label: string) => toolItem({
      id, label, category: 'harness', status: 'update-available', actions: ['update-recommended'], runActions: ['update', 'requalify'],
      installed: { version: '1.0.0', admittedAt: null, admission: 'verified', source: 'admission-record' },
      recommended: { version: '1.1.0', proven: false },
    });
    api.getStatus.mockResolvedValue(toolsStatus({
      tools: [harness('ollama', 'Ollama'), harness('hermes', 'Hermes'), harness('grok-build', 'Grok Build')],
    }));
    const user = userEvent.setup();
    render(<AiToolsPanel owner />);
    const ollama = await screen.findByRole('article', { name: 'Ollama' });
    expect(within(ollama).getByText('Restarts the local model server; your models are kept.')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Grok Build' })).getByText('No OpenClaw restart.')).toBeInTheDocument();
    const expected: Array<[string, string]> = [
      ['Ollama', 'Restarts the local model server; your models are kept.'],
      ['Hermes', 'Builds the new version next to the current one (downloads its source, uv and Python; a few minutes) and switches only at the end; the OpenClaw gateway is not touched.'],
      ['Grok Build', 'No OpenClaw restart. The previous version is kept so the update can be undone if its checks fail.'],
    ];
    for (const [label, text] of expected) {
      await user.click(screen.getByRole('button', { name: `Update ${label} to 1.1.0` }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(text)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    }
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it('the OpenClaw card shows the PF-8 disk line from the latest pre-flight, when present', () => {
    const checkedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const { unmount } = render(<AiToolCard tool={openclawItem({ diskCheck: { messages: ['Needs 49.0 GB free on /, has 19.0 GB.'], checkedAt } })}
      owner busy={false} onRequest={vi.fn()} onNextAction={vi.fn()} />);
    expect(screen.getByTestId('ai-tool-openclaw-disk')).toHaveTextContent('Disk space (latest pre-flight, 5 min ago): Needs 49.0 GB free on /, has 19.0 GB.');
    unmount();
    render(<AiToolCard tool={openclawItem({ diskCheck: null })} owner busy={false} onRequest={vi.fn()} onNextAction={vi.fn()} />);
    expect(screen.queryByTestId('ai-tool-openclaw-disk')).toBeNull();
  });

  it('the OpenClaw card says when chat is unavailable for the whole update (K7 mode B)', () => {
    const item = (updateMode: unknown) => ({ ...openclawItem({}), updateMode }) as any;
    const first = render(<AiToolCard tool={item({ mode: 'stopped', reason: 'service-inspection', checkedAt: null })}
      owner busy={false} onRequest={vi.fn()} onNextAction={vi.fn()} />);
    expect(screen.getByTestId('ai-tool-openclaw-update-mode')).toHaveTextContent("Chat will be unavailable for the whole update: "
      + "the installed OpenClaw can't check its own service while chat runs, so the gateway is stopped first and started again at the end.");
    expect(screen.queryByText(/active chats pause for a few minutes/)).toBeNull();
    first.unmount();
    const second = render(<AiToolCard tool={item({ mode: 'stopped', reason: 'no-replacement-watcher', checkedAt: null })}
      owner busy={false} onRequest={vi.fn()} onNextAction={vi.fn()} />);
    expect(screen.getByTestId('ai-tool-openclaw-update-mode')).toHaveTextContent("can't hand over while chat stays up");
    second.unmount();
    const third = render(<AiToolCard tool={item({ mode: 'live', reason: 'replacement-watcher', checkedAt: null })}
      owner busy={false} onRequest={vi.fn()} onNextAction={vi.fn()} />);
    expect(screen.getByTestId('ai-tool-openclaw-update-mode')).toHaveTextContent('chat keeps working until OpenClaw switches over');
    expect(screen.getByText(/active chats pause for a few minutes/)).toBeInTheDocument();
    third.unmount();
    const fourth = render(<AiToolCard tool={item(null)} owner busy={false} onRequest={vi.fn()} onNextAction={vi.fn()} />);
    expect(screen.queryByTestId('ai-tool-openclaw-update-mode')).toBeNull();
    fourth.unmount();
    // The impact line follows the mode (it is the only line shown when no pre-flight recorded one).
    expect(toolImpactLine(item({ mode: 'stopped', reason: 'service-inspection', checkedAt: null })))
      .toBe('Stops OpenClaw for the whole update; chat is unavailable until it starts again; large installations can take up to 2 hours.');
    expect(toolImpactLine(item({ mode: 'live', reason: 'replacement-watcher', checkedAt: null })))
      .toBe('Restarts OpenClaw; active chats pause for a few minutes while it switches over; large installations can take up to 2 hours.');
    expect(toolImpactLine(item(null))).toBe('Restarts OpenClaw; chat pauses for the switch-over, or for the whole update if the '
      + 'installed OpenClaw needs that; large installations can take up to 2 hours.');
  });

  it('a recovery that left OpenClaw running again says so and offers Retry checks', () => {
    const message = 'OpenClaw 2026.10.9 is running again, but its checks failed (OC-CONFIG); the Portal could not return to 2026.9.9: x.';
    const onNextAction = vi.fn();
    render(<AiToolRunResult tool={openclawItem({ runActions: ['retry-checks'], lastRun: lastRun({
      state: 'recovery-required', errorId: 'ROLLBACK_REFUSED', nextAction: 'retry-checks', message }) })}
      owner busy={false} onNextAction={onNextAction} />);
    expect(screen.getByText('OpenClaw is running, but its Portal checks did not pass.')).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry checks' }));
    expect(onNextAction).toHaveBeenCalledWith('retry-checks');
  });

  it('every Hermes step has a label, and a re-check that asks for an update says so in words', () => {
    // impl-harness3 contract: requalify and update steps.
    for (const step of ['installed', 'resolve', 'fetch', 'compare', 'probe', 'commit', 'stage', 'probe-candidate', 'swap', 'probe-installed', 'cleanup']) {
      expect(runPhaseLabel({ phase: step, nativePhase: null })).not.toBe(step);
    }
    const { unmount } = render(<AiToolsRunProgress toolLabel="Hermes" run={activeRun({ tool: 'hermes', phase: 'stage' })} />);
    expect(screen.getByRole('heading', { name: 'Hermes: Building the new version' })).toBeInTheDocument();
    unmount();
    const hermes = toolItem({
      id: 'hermes', label: 'Hermes', category: 'harness',
      lastRun: lastRun({
        action: 'requalify', state: 'refused', errorId: 'HARNESS_BINARY_DIFFERS', nextAction: 'update-recommended', from: null, to: null,
        message: 'The installed Hermes 0.22.5 is not the release its tag names.',
      }),
    });
    render(<AiToolRunResult tool={hermes} owner busy={false} onNextAction={vi.fn()} />);
    expect(screen.getByText('Next step: Update it to the recommended version.')).toBeInTheDocument();
    expect(screen.queryByText(/update-recommended/)).toBeNull();
  });

  it('an earlier refusal says how old it is, so its present-tense reason never reads as today\'s answer', () => {
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const reason = "OpenClaw's own update check didn't complete, so the update can't start.";
    const card = (run: ReturnType<typeof lastRun>) => render(<AiToolRunResult tool={openclawItem({ lastRun: run })} owner busy={false}
      onNextAction={vi.fn()} />);
    const { unmount } = card(lastRun({ state: 'refused', errorId: 'PF11_DRY_RUN_FAILED', message: reason, startedAt: at(185), endedAt: at(180) }));
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.getByTestId('ai-tool-openclaw-result-age')).toHaveTextContent(/^This result is from a run 3 h ago\.$/);
    unmount();
    // A fresh refusal, and any result that is not a refusal, carry no age line.
    for (const run of [lastRun({ state: 'refused', message: reason, startedAt: at(6), endedAt: at(5) }),
      lastRun({ state: 'succeeded', startedAt: at(185), endedAt: at(180) }), lastRun({ state: 'failed', message: 'x', endedAt: at(180) })]) {
      const { unmount: done } = card(run);
      expect(screen.queryByTestId('ai-tool-openclaw-result-age')).toBeNull();
      done();
    }
    expect(refusalAge({ state: 'refused', startedAt: at(40), endedAt: null })).toBe('40 min');
    expect(refusalAge({ state: 'refused', startedAt: null, endedAt: null })).toBeNull();
  });

  it('a refused update that installed Portal plugins first never says "Nothing was changed" (N4)', () => {
    const message = 'OpenClaw refused the update before starting it: x. OpenClaw itself was not changed, but the Portal had '
      + 'already installed its plugin bridgesllm-shared-browser 1.0.0 into it; it stays installed.';
    const refused = (pluginsInstalled?: string[]) => openclawItem({
      lastRun: lastRun({ action: 'update', state: 'refused', errorId: 'NATIVE_ADMISSION_REFUSED', message, pluginsInstalled }),
    });
    const { unmount } = render(<AiToolRunResult tool={refused(['bridgesllm-shared-browser 1.0.0'])} owner busy={false} onNextAction={vi.fn()} />);
    expect(screen.getByText('Not updated.')).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing was changed/)).toBeNull();
    unmount();
    render(<AiToolRunResult tool={refused()} owner busy={false} onNextAction={vi.fn()} />);
    expect(screen.getByText('Not updated. Nothing was changed.')).toBeInTheDocument();
  });

  it('"Update to newest" needs an explicit per-run opt-in that says how the assurance changes (i.3)', async () => {
    api.getStatus.mockResolvedValue(toolsStatus({ tools: [toolItem()] }));
    const user = userEvent.setup();
    render(<AiToolsPanel owner />);
    await user.click(await screen.findByRole('button', { name: 'Update Codex CLI to newest' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Codex CLI will be updated to the newest release (not yet tested by this Portal).');
    expect(within(dialog).getByTestId('ai-tools-newest-opt-in')).toHaveTextContent(
      'Update to newest installs a release this Portal has not tested. Assurance moves from “this Portal tested these bytes” to “the official publisher produced them”: the download is checked only against what the publisher provides.',
    );
    const confirm = within(dialog).getByRole('button', { name: 'Update Codex CLI' });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: /newest release on the publisher's assurance, for this update only/ }));
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(api.startRun).toHaveBeenCalledWith({ tool: 'codex', action: 'update', target: 'newest', confirmed: true });
  });

  it('the recommended update has no newest opt-in', async () => {
    api.getStatus.mockResolvedValue(toolsStatus({
      tools: [toolItem({ status: 'update-available', installed: { version: '0.163.0', admittedAt: null, admission: 'verified', source: 'admission-record' }, actions: ['update-recommended'] })],
    }));
    const user = userEvent.setup();
    render(<AiToolsPanel owner />);
    await user.click(await screen.findByRole('button', { name: 'Update Codex CLI to 0.166.0' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByTestId('ai-tools-newest-opt-in')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Update Codex CLI' })).toBeEnabled();
  });

  it('Stop is disabled with its reason while Ollama switches versions, and the server refusal is shown if it still arrives', async () => {
    const reason = 'Ollama\'s installer is switching versions and restarting the local model server; stopping it now could leave Ollama stopped. Stop is available again when this step ends.';
    api.getStatus.mockResolvedValue(toolsStatus({
      activeRun: activeRun({ tool: 'ollama', phase: 'swap', stopRefusal: reason }),
      tools: [toolItem({ id: 'ollama', label: 'Ollama', category: 'runtime', status: 'updating', actions: [], runActions: [] })],
    }));
    render(<AiToolsPanel owner />);
    const progress = await screen.findByRole('region', { name: 'Ollama: Switching versions' });
    const button = within(progress).getByRole('button', { name: 'Stop this update' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(reason);
    expect(api.stopRun).not.toHaveBeenCalled();
  });

  it('Stop asks once, then sends the stop for the running run; admins see no Stop', async () => {
    const status = toolsStatus({
      activeRun: activeRun({ tool: 'codex', phase: 'probe', stopRefusal: null }),
      tools: [toolItem({ status: 'updating', actions: [], runActions: [] })],
    });
    api.getStatus.mockResolvedValue(status);
    const user = userEvent.setup();
    const { unmount } = render(<AiToolsPanel owner />);
    await user.click(await screen.findByRole('button', { name: 'Stop this update' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop the Codex CLI update' });
    expect(dialog).toHaveTextContent('The update stops at its next safe point. The result on this page then says what changed and what to do next.');
    expect(api.stopRun).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Stop this update' }));
    expect(api.stopRun).toHaveBeenCalledWith('0b6c2f1e-4a59-4d38-9d0e-2a7f5c1b9e01');
    expect(await screen.findByText('Stop requested. The Codex CLI update stops at its next safe point; the result appears here.')).toBeInTheDocument();
    unmount();
    render(<AiToolsPanel owner={false} />);
    await screen.findByRole('region', { name: 'Codex CLI: Testing' });
    expect(screen.queryByRole('button', { name: 'Stop this update' })).toBeNull();
  });

  it('Stop during an install says installation throughout', async () => {
    api.getStatus.mockResolvedValue(toolsStatus({
      activeRun: activeRun({ tool: 'codex', phase: 'probe', stopRefusal: null, action: 'install' }),
      tools: [toolItem({ status: 'updating', actions: [], runActions: [] })],
    }));
    const user = userEvent.setup();
    render(<AiToolsPanel owner />);
    await user.click(await screen.findByRole('button', { name: 'Stop this installation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop the Codex CLI installation' });
    expect(dialog).toHaveTextContent('The installation stops at its next safe point.');
    await user.click(within(dialog).getByRole('button', { name: 'Stop this installation' }));
    expect(await screen.findByText('Stop requested. The Codex CLI installation stops at its next safe point; the result appears here.')).toBeInTheDocument();
  });

  it('a stop the server refuses keeps the dialog open with its reason', async () => {
    api.getStatus.mockResolvedValue(toolsStatus({
      activeRun: activeRun({ tool: 'hermes', phase: 'probe-candidate', stopRefusal: null }),
      tools: [toolItem({ id: 'hermes', label: 'Hermes', category: 'harness', status: 'updating', actions: [], runActions: [] })],
    }));
    api.stopRun.mockRejectedValue({ response: { data: { error: 'Hermes is building its new version in one long step; the current version keeps working meanwhile. Stop is available again when this step ends. Nothing was stopped.' } } });
    const user = userEvent.setup();
    render(<AiToolsPanel owner />);
    await user.click(await screen.findByRole('button', { name: 'Stop this update' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop the Hermes update' });
    await user.click(within(dialog).getByRole('button', { name: 'Stop this update' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Nothing was stopped\.$/);
  });

  it('a stop request that never reached the server says nothing was stopped', async () => {
    api.getStatus.mockResolvedValue(toolsStatus({
      activeRun: activeRun({ tool: 'codex', phase: 'fetch', stopRefusal: null }),
      tools: [toolItem({ status: 'updating', actions: [], runActions: [] })],
    }));
    api.stopRun.mockRejectedValue(new Error(''));
    const user = userEvent.setup();
    render(<AiToolsPanel owner />);
    await user.click(await screen.findByRole('button', { name: 'Stop this update' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop the Codex CLI update' });
    await user.click(within(dialog).getByRole('button', { name: 'Stop this update' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The stop request could not be sent. Nothing was stopped.');
  });
});
