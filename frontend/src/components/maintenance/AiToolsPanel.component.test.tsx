// @vitest-environment jsdom
import '../../test/setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AiToolsPanel from './AiToolsPanel';
import { activeRun, missingItem, openclawItem, toolItem, toolsStatus } from './toolsFixtures';

const api = vi.hoisted(() => ({ getStatus: vi.fn(), startRun: vi.fn(), startReconcile: vi.fn() }));

vi.mock('../../api/maintenanceTools', () => ({
  maintenanceToolsAPI: { getStatus: api.getStatus, startRun: api.startRun, startReconcile: api.startReconcile },
}));

function card(name: string) {
  return screen.getByRole('article', { name });
}

describe('AI tools panel', () => {
  beforeEach(() => {
    api.getStatus.mockReset();
    api.startRun.mockReset();
    api.startRun.mockResolvedValue({ runId: 'r1' });
    api.startReconcile.mockReset();
    api.startReconcile.mockResolvedValue({ started: true, runId: 'r0' });
  });

  it('shows one honest card per installed tool with its plain state', async () => {
    api.getStatus.mockResolvedValue(toolsStatus({
      tools: [
        openclawItem(),
        toolItem(),
        toolItem({ id: 'clawhub', label: 'ClawHub', status: 'ok', newerThanTested: true, installed: { version: '0.24.2', admittedAt: null, admission: 'requalified', source: 'admission-record' }, statusReason: 'Newer than tested: 0.24.1 is the newest version this Portal has tested.' }),
        toolItem({ id: 'claude-code', label: 'Claude Code', status: 'drifted-requalifying', actions: ['requalify'], installed: { version: '2.1.320', admittedAt: null, admission: 'unverified', source: 'package-json' }, statusReason: 'Claude Code changed itself (now 2.1.320, last checked 2.1.314). Re-check it before relying on it.' }),
        toolItem({ id: 'hermes', label: 'Hermes', status: 'not-installed', actions: [], runActions: [] }),
      ],
    }));
    render(<AiToolsPanel owner />);
    expect(await screen.findByText('Updates are available for OpenClaw.')).toBeInTheDocument();
    expect(within(card('OpenClaw')).getByTestId('ai-tool-openclaw-chip')).toHaveTextContent('Update available');
    // No pre-flight yet: the impact line names both K7 modes instead of promising a short pause.
    expect(within(card('OpenClaw')).getByText(/Restarts OpenClaw; chat pauses for the switch-over, or for the whole update/))
      .toBeInTheDocument();
    expect(within(card('Codex CLI')).getByTestId('ai-tool-codex-chip')).toHaveTextContent('Current');
    expect(within(card('Codex CLI')).getByText('No OpenClaw restart.')).toBeInTheDocument();
    expect(within(card('Codex CLI')).getByText('Verified source')).toBeInTheDocument();
    expect(within(card('ClawHub')).getByTestId('ai-tool-clawhub-chip')).toHaveTextContent('Newer than tested');
    expect(within(card('ClawHub')).getByText('Re-qualified')).toBeInTheDocument();
    const drifted = card('Claude Code');
    expect(within(drifted).getByTestId('ai-tool-claude-code-chip')).toHaveTextContent('Changed itself — re-check');
    expect(within(drifted).getByRole('button', { name: 'Re-check Claude Code' })).toBeEnabled();
    expect(within(drifted).queryByRole('button', { name: /^Update/ })).toBeNull();
    expect(screen.queryByRole('article', { name: 'Hermes' })).toBeNull();
    expect(screen.getByText('Not installed on this server: Hermes.')).toBeInTheDocument();
  });

  it('labels a failed read as checking with the age of the last good result', async () => {
    api.getStatus.mockResolvedValue(toolsStatus({
      tools: [openclawItem({ status: 'unknown-retrying', actions: [], statusReason: 'Checking again. Last confirmed 3 min ago.', lastGoodAt: new Date(Date.now() - 3 * 60_000).toISOString() })],
    }));
    render(<AiToolsPanel owner />);
    const openclaw = await screen.findByRole('article', { name: 'OpenClaw' });
    expect(within(openclaw).getByTestId('ai-tool-openclaw-chip')).toHaveTextContent('Checking');
    expect(within(openclaw).getByText('Showing the last confirmed result from 3 min ago.')).toBeInTheDocument();
    expect(within(openclaw).queryByRole('button', { name: /Update/ })).toBeNull();
  });

  it('never offers Update while a recovery is open; repair is the only action', async () => {
    api.getStatus.mockResolvedValue(toolsStatus({
      recovery: { kind: 'tools-run-interrupted', title: 'OpenClaw needs recovery. Chat may be unavailable.', detail: 'OpenClaw could not confirm its rollback.', action: { id: 'recover-native', label: 'Run OpenClaw repair' } },
      tools: [
        openclawItem({ status: 'recovery-required', actions: [], runActions: ['recover-native'], statusReason: 'OpenClaw needs recovery. Chat may be unavailable.' }),
        toolItem({ status: 'recovery-required', actions: [], runActions: [] }),
      ],
      summary: { status: 'recovery-required', text: 'OpenClaw needs recovery. Chat may be unavailable. Run OpenClaw repair to continue.', counts: {} },
    }));
    const user = userEvent.setup();
    render(<AiToolsPanel owner />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No update is offered until this is resolved.');
    expect(screen.queryByRole('button', { name: /^Update/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Re-check/ })).toBeNull();
    expect(within(card('OpenClaw')).getByTestId('ai-tool-openclaw-chip')).toHaveTextContent('Recovery open');
    await user.click(within(alert).getByRole('button', { name: 'Run OpenClaw repair' }));
    // One explicit confirm before the repair starts.
    expect(api.startRun).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Run OpenClaw repair' });
    expect(dialog).toHaveTextContent('No new version is installed.');
    // K7: a repair stops the gateway for its whole length.
    expect(dialog).toHaveTextContent('The OpenClaw gateway is stopped for the whole repair, so chat is unavailable until it starts again at the end.');
    expect(dialog).not.toHaveTextContent(/few minutes/);
    await user.click(within(dialog).getByRole('button', { name: 'Run OpenClaw repair' }));
    expect(api.startRun).toHaveBeenCalledWith({ tool: 'openclaw', action: 'recover-native', confirmed: true });
  });

  it('offers only Retry checks when OpenClaw is running again after a refused rollback', async () => {
    const message = 'OpenClaw 2026.10.9 is running again, but its checks failed (OC-CONFIG); the Portal could not return to '
      + '2026.9.9: The previous version can\'t read the migrated state.';
    const title = 'OpenClaw is running, but its Portal checks did not pass.';
    api.getStatus.mockResolvedValue(toolsStatus({
      recovery: { kind: 'tools-run-interrupted', title, detail: message, action: { id: 'retry-checks', label: 'Retry checks' }, tool: 'openclaw' },
      tools: [
        openclawItem({ status: 'recovery-required', actions: [], runActions: ['retry-checks'], statusReason: title }),
        toolItem({ status: 'recovery-required', actions: [], runActions: [] }),
      ],
      summary: { status: 'recovery-required', text: `${title} Retry checks to continue.`, counts: {} },
    }));
    const user = userEvent.setup();
    render(<AiToolsPanel owner />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(screen.queryByRole('button', { name: /^Update|^Re-check|^Run OpenClaw repair|^Check whether/ })).toBeNull();
    await user.click(within(alert).getByRole('button', { name: 'Retry checks' }));
    expect(api.startRun).toHaveBeenCalledWith({ tool: 'openclaw', action: 'retry-checks' });
  });

  it('hides every change while recovery is open even if a payload still lists actions', async () => {
    api.getStatus.mockResolvedValue(toolsStatus({
      recovery: { kind: 'legacy-ledger', title: 'An earlier maintenance run is unfinished.', detail: 'Recover it first.', action: { id: 'recover-legacy', label: 'Recover interrupted maintenance' } },
      tools: [openclawItem(), toolItem({ status: 'drifted-requalifying', actions: ['requalify'] })],
    }));
    render(<AiToolsPanel owner />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: /^Update|^Re-check|^Check whether/ })).toBeNull();
  });

  it('a recovery the API cannot run here shows its instruction instead of a button', async () => {
    api.getStatus.mockResolvedValue(toolsStatus({
      recovery: { kind: 'legacy-ledger', title: 'An earlier maintenance run is unfinished.', detail: 'Recover it first.', action: { id: 'recover-legacy', label: 'Recover interrupted maintenance' } },
      tools: [openclawItem({ status: 'recovery-required', actions: [], runActions: [] })],
    }));
    render(<AiToolsPanel owner />);
    const alert = await screen.findByRole('alert');
    expect(within(alert).queryByRole('button')).toBeNull();
    expect(alert).toHaveTextContent('Next step: Recover interrupted maintenance.');
  });

  const recheckRecovery = () => toolsStatus({
    recovery: {
      kind: 'tools-run-interrupted', title: 'The ClawHub update needs to be checked.', detail: 'The ClawHub files are missing.',
      action: { id: 'requalify', label: 'Re-check ClawHub' }, runId: 'r0', tool: 'clawhub',
    },
    tools: [
      openclawItem({ status: 'recovery-required', actions: [], runActions: [] }),
      toolItem({ id: 'clawhub', label: 'ClawHub', status: 'recovery-required', actions: [], runActions: ['requalify'] }),
    ],
    summary: { status: 'recovery-required', text: 'The ClawHub update needs to be checked. Re-check ClawHub to continue.', counts: {} },
  });
  const interruptedRecovery = () => toolsStatus({
    recovery: {
      kind: 'tools-run-interrupted', title: 'An AI tools update stopped unexpectedly.', detail: 'Its runner is no longer running.',
      action: { id: 'reconcile-tools-run', label: 'Check interrupted update' }, runId: 'r0',
    },
    activeRun: activeRun({ stale: true, stopRefusal: 'Its runner is no longer running, so there is nothing to stop. Check the interrupted update instead.' }),
    tools: [openclawItem({ status: 'recovery-required', actions: [], runActions: [] }), toolItem({ status: 'recovery-required', actions: [], runActions: [] })],
    summary: { status: 'recovery-required', text: 'An AI tools update stopped unexpectedly. Check interrupted update to continue.', counts: {} },
  });

  it('another tool\'s recovery offers its Re-check, started exactly like the card\'s Re-check', async () => {
    api.getStatus.mockResolvedValue(recheckRecovery());
    const user = userEvent.setup();
    render(<AiToolsPanel owner />);
    const alert = await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: /^Update/ })).toBeNull();
    await user.click(within(alert).getByRole('button', { name: 'Re-check ClawHub' }));
    expect(api.startRun).toHaveBeenCalledWith({ tool: 'clawhub', action: 'requalify' });
    expect(await screen.findByText('Re-checking ClawHub. Nothing is installed.')).toBeInTheDocument();
  });

  it('an interrupted run offers its check while the run is still listed; the page reloads after it starts', async () => {
    api.getStatus.mockResolvedValue(interruptedRecovery());
    const user = userEvent.setup();
    render(<AiToolsPanel owner />);
    const alert = await screen.findByRole('alert');
    const check = within(alert).getByRole('button', { name: 'Check interrupted update' });
    expect(check).toBeEnabled();
    const reads = api.getStatus.mock.calls.length;
    await user.click(check);
    expect(api.startReconcile).toHaveBeenCalledTimes(1);
    expect(api.startRun).not.toHaveBeenCalled();
    await waitFor(() => expect(api.getStatus).toHaveBeenCalledWith(true));
    expect(api.getStatus.mock.calls.length).toBeGreaterThan(reads);
    expect(await screen.findByText(/^Checking the interrupted update\./)).toBeInTheDocument();
  });

  it('a refused check shows the server\'s reason verbatim', async () => {
    api.getStatus.mockResolvedValue(interruptedRecovery());
    api.startReconcile.mockRejectedValue({ response: { data: { error: 'No interrupted AI tools update is waiting to be checked.' } } });
    const user = userEvent.setup();
    render(<AiToolsPanel owner />);
    await user.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Check interrupted update' }));
    expect(await screen.findByText('No interrupted AI tools update is waiting to be checked.')).toBeInTheDocument();
  });

  it('a non-owner sees the recovery step as text only', async () => {
    for (const fixture of [recheckRecovery(), interruptedRecovery()]) {
      api.getStatus.mockResolvedValue(fixture);
      const { unmount } = render(<AiToolsPanel owner={false} />);
      const alert = await screen.findByRole('alert');
      expect(within(alert).queryByRole('button')).toBeNull();
      expect(alert).toHaveTextContent(`Next step: ${fixture.recovery!.action.label}. Ask the Owner to do this.`);
      unmount();
    }
    expect(api.startRun).not.toHaveBeenCalled();
    expect(api.startReconcile).not.toHaveBeenCalled();
  });

  it('an npm CLI update needs one confirm and no typed phrase', async () => {
    api.getStatus.mockResolvedValue(toolsStatus({
      tools: [toolItem({ status: 'update-available', installed: { version: '0.163.0', admittedAt: null, admission: 'verified', source: 'admission-record' }, actions: ['update-recommended', 'update-newest'], statusReason: '0.166.0 is recommended (not yet qualified).' })],
    }));
    const user = userEvent.setup();
    render(<AiToolsPanel owner />);
    await user.click(await screen.findByRole('button', { name: 'Update Codex CLI to 0.166.0' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(within(dialog).getByText(/No OpenClaw restart/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Update Codex CLI' }));
    expect(api.startRun).toHaveBeenCalledWith({ tool: 'codex', action: 'update', target: 'recommended', confirmed: true });
  });

  it('a refusal of a run asked for in a dialog is said once, in the dialog', async () => {
    const refusal = 'A comprehensive archive exists, but Portal cannot authenticate its completeness classification. '
      + 'Create a comprehensive maintenance backup in an approved window and wait for it to complete.';
    api.getStatus.mockResolvedValue(toolsStatus({
      tools: [toolItem({ status: 'update-available', installed: { version: '0.163.0', admittedAt: null, admission: 'verified', source: 'admission-record' }, actions: ['update-recommended', 'update-newest'], statusReason: '0.166.0 is recommended (not yet qualified).' })],
    }));
    api.startRun.mockRejectedValue({ response: { data: { error: refusal } } });
    const user = userEvent.setup();
    render(<AiToolsPanel owner />);
    await user.click(await screen.findByRole('button', { name: 'Update Codex CLI to 0.166.0' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Update Codex CLI' }));
    expect(await within(dialog).findByText(refusal)).toBeInTheDocument();
    expect(screen.getAllByText(refusal)).toHaveLength(1);
  });

  it('a missing tool this Portal can install gets its card: Install <version> with one confirm', async () => {
    api.getStatus.mockResolvedValue(toolsStatus({
      tools: [openclawItem(), missingItem(), missingItem({ id: 'agent-zero', label: 'Agent Zero', statusReason: 'Not configured.', actions: [], runActions: [], installVersion: null })],
    }));
    const user = userEvent.setup();
    render(<AiToolsPanel owner />);
    const codex = await screen.findByRole('article', { name: 'Codex CLI' });
    expect(within(codex).getByText('Not installed on this server.')).toBeInTheDocument();
    expect(within(codex).queryByText('Installed version unknown')).toBeNull();
    // A missing tool Maintenance cannot install stays a name in the list.
    expect(screen.queryByRole('article', { name: 'Agent Zero' })).toBeNull();
    expect(screen.getByText('Not installed on this server: Agent Zero.')).toBeInTheDocument();
    await user.click(within(codex).getByRole('button', { name: 'Install Codex CLI 0.166.0' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install Codex CLI' });
    expect(within(dialog).getByText('Codex CLI 0.166.0 will be installed on this server.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(within(dialog).getByText(/what was installed is removed again/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Install Codex CLI' }));
    expect(api.startRun).toHaveBeenCalledWith({ tool: 'codex', action: 'install', target: 'recommended', confirmed: true });
    expect(await screen.findByText('Codex CLI installation started. It continues on the server if you leave this page.')).toBeInTheDocument();
  });

  it('Install is Owner-only, hidden while another run or a recovery is open, and its result reads Installed', async () => {
    api.getStatus.mockResolvedValue(toolsStatus({ tools: [openclawItem(), missingItem()] }));
    const { unmount } = render(<AiToolsPanel owner={false} />);
    const button = await screen.findByRole('button', { name: 'Install Codex CLI 0.166.0' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Only the Owner can change the server.');
    unmount();
    // Another run is open: the card stays (it names the version) but offers nothing.
    api.getStatus.mockResolvedValue(toolsStatus({ tools: [openclawItem({ actions: [], runActions: [] }), missingItem({ actions: [], runActions: [] })], activeRun: activeRun({ tool: 'openclaw' }) }));
    const busy = render(<AiToolsPanel owner />);
    expect(await screen.findByRole('article', { name: 'Codex CLI' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Install / })).toBeNull();
    busy.unmount();
    api.getStatus.mockResolvedValue(toolsStatus({ tools: [toolItem({ lastRun: { runId: 'r1', action: 'install', state: 'succeeded', startedAt: null, endedAt: null, from: null, to: '0.166.0', errorId: null, message: null, nextAction: null, refusals: [] } })] }));
    render(<AiToolsPanel owner />);
    expect(await screen.findByText('Installed Codex CLI 0.166.0.')).toBeInTheDocument();
  });

  it('re-check starts at once and installs nothing; a refusal from the server is shown verbatim', async () => {
    api.getStatus.mockResolvedValue(toolsStatus({
      tools: [toolItem({ status: 'drifted-requalifying', actions: ['requalify'] })],
    }));
    api.startRun.mockRejectedValue({ response: { data: { error: 'requalify is not implemented for codex by this runner build.' } } });
    const user = userEvent.setup();
    render(<AiToolsPanel owner />);
    await user.click(await screen.findByRole('button', { name: 'Re-check Codex CLI' }));
    expect(api.startRun).toHaveBeenCalledWith({ tool: 'codex', action: 'requalify' });
    expect(await screen.findByText('requalify is not implemented for codex by this runner build.')).toBeInTheDocument();
  });

  it('admins read the same cards but every server change is Owner-only', async () => {
    api.getStatus.mockResolvedValue(toolsStatus());
    render(<AiToolsPanel owner={false} />);
    const button = await screen.findByRole('button', { name: 'Update OpenClaw to 2026.10.9' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Only the Owner can change the server.');
    expect(screen.queryByLabelText('OpenClaw channel')).toBeNull();
  });

  it('without the per-tool runner the cards are read-only and point to the old update path', async () => {
    api.getStatus.mockResolvedValue(toolsStatus({
      runner: { installed: false, reason: 'This installation does not include the per-tool AI updater yet.' },
      tools: [openclawItem({ actions: [], runActions: [] }), toolItem({ actions: [], runActions: [] })],
    }));
    render(<AiToolsPanel owner />);
    expect(await screen.findByText(/still updated together with Update Compatible AI Tools/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Update|^Re-check|^Check whether/ })).toBeNull();
  });

  it('the OpenClaw channel choice travels with the read-only check', async () => {
    api.getStatus.mockResolvedValue(toolsStatus());
    const user = userEvent.setup();
    render(<AiToolsPanel owner />);
    await user.selectOptions(await screen.findByLabelText('OpenClaw channel'), 'extended-stable');
    await user.click(screen.getByRole('button', { name: 'Check whether OpenClaw can update' }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledWith({ tool: 'openclaw', action: 'preflight', channel: 'extended-stable' }));
  });
});
