// @vitest-environment jsdom
import '../../test/setup';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AiToolsPanel from './AiToolsPanel';
import { openclawItem, toolItem, toolsStatus } from './toolsFixtures';

const api = vi.hoisted(() => ({ getStatus: vi.fn(), startRun: vi.fn() }));

vi.mock('../../api/maintenanceTools', () => ({
  maintenanceToolsAPI: { getStatus: api.getStatus, startRun: api.startRun },
}));

const BACKUP = { createdAt: new Date(Date.now() - 90 * 60_000).toISOString(), ageHours: 1.5 };

async function openReview(backup: typeof BACKUP | null = BACKUP) {
  const user = userEvent.setup();
  render(<AiToolsPanel owner backup={backup} />);
  await user.click(await screen.findByRole('button', { name: 'Update OpenClaw to 2026.10.9' }));
  const dialog = await screen.findByRole('dialog', { name: 'Review the OpenClaw update' });
  return { user, dialog };
}

describe('OpenClaw update consent review', () => {
  beforeEach(() => {
    api.getStatus.mockReset();
    api.startRun.mockReset();
    api.getStatus.mockResolvedValue(toolsStatus());
    api.startRun.mockResolvedValue({ runId: 'r1' });
  });

  it('says that the typed confirmation also accepts the capabilities of the Portal\'s own plugins, and only those', async () => {
    const { dialog } = await openReview();
    expect(within(dialog).getByTestId('openclaw-consent-plugins')).toHaveTextContent(
      'Typing the confirmation also accepts the capabilities of the Portal\'s own OpenClaw plugins when they are reloaded for the new version (only the plugins this Portal release ships; OpenClaw\'s --accept-capabilities). Other plugins are not changed.',
    );
  });

  it('says exactly what will happen: checks and backup first, the restart window, chat pause and automatic rollback', async () => {
    const { dialog } = await openReview();
    expect(dialog).toHaveTextContent('OpenClaw 2026.9.9 will be updated to 2026.10.9 from the stable channel. This can take up to 2 hours on large installations.');
    const steps = within(within(dialog).getByRole('list', { name: 'What will happen' })).getAllByRole('listitem').map((item) => item.textContent);
    expect(steps).toHaveLength(5);
    expect(steps[0]).toMatch(/^Checks first: .*verified maintenance backup\. If any check fails, nothing is changed/);
    // No pre-flight recorded the K7 mode yet: both are named; nothing promises chat stays up throughout.
    expect(steps[2]).toBe('OpenClaw installs the new version and tests it on a copy of its data. Chats keep working during this step, unless the checks find the installed OpenClaw can\'t hand over while chat runs: then the gateway is stopped first and chat is unavailable for the whole update.');
    expect(steps[3]).toBe('OpenClaw switches over: the gateway stops while OpenClaw finishes its maintenance, then starts again. Active chats pause for this step, usually a few minutes.');
    expect(steps.join(' ')).not.toMatch(/Node\.js is updated/);
    expect(dialog).toHaveTextContent('If OpenClaw\'s own checks fail, or the new version does not start or answer the Portal\'s '
      + 'chat checks, it automatically returns to 2026.9.9');
    expect(dialog).toHaveTextContent('If only the check for agents\' questions fails, OpenClaw stays on the new version with chat working');
    expect(dialog).toHaveTextContent('(OpenClaw repair, or Retry checks when the new version is running again)');
    expect(within(dialog).getByLabelText(/This is a good time/)).toBeInTheDocument();
    expect(dialog).toHaveTextContent('people using chat know it will pause during the update, possibly for all of it.');
    expect(dialog).toHaveTextContent('no other update is offered until that is done');
    expect(within(dialog).getByTestId('openclaw-consent-backup')).toHaveTextContent('latest verified maintenance backup (90 min old)');
    expect(within(dialog).getByLabelText(/Also update Node\.js/)).not.toBeChecked();
    expect(within(dialog).getByRole('textbox')).toBeInTheDocument();
  });

  it('in mode B says chat is unavailable for the whole update and never promises a short pause', async () => {
    api.getStatus.mockResolvedValue(toolsStatus({
      tools: [openclawItem({ updateMode: { mode: 'stopped', reason: 'service-inspection', checkedAt: null } }), toolItem()],
    }));
    const { dialog } = await openReview();
    const steps = within(within(dialog).getByRole('list', { name: 'What will happen' })).getAllByRole('listitem').map((item) => item.textContent);
    expect(steps[2]).toBe('The OpenClaw gateway is stopped first, so chat is unavailable from here to the end. OpenClaw then installs '
      + 'the new version and tests it on a copy of its data.');
    expect(steps[3]).toBe('OpenClaw switches over and finishes its maintenance, then the gateway starts again and chat returns.');
    expect(dialog).toHaveTextContent('people using chat know it will be unavailable for the whole update.');
    expect(dialog).not.toHaveTextContent(/few minutes|Chats keep working/);
  });

  it('in mode A says chat keeps working until the switch-over, then pauses', async () => {
    api.getStatus.mockResolvedValue(toolsStatus({
      tools: [openclawItem({ updateMode: { mode: 'live', reason: 'replacement-watcher', checkedAt: null } }), toolItem()],
    }));
    const { dialog } = await openReview();
    const steps = within(within(dialog).getByRole('list', { name: 'What will happen' })).getAllByRole('listitem').map((item) => item.textContent);
    expect(steps[2]).toBe('OpenClaw installs the new version and tests it on a copy of its data. Chats keep working during this step.');
    expect(steps[3]).toBe('OpenClaw switches over: the gateway stops while OpenClaw finishes its maintenance, then starts again. Active chats pause for this step, usually a few minutes.');
    expect(dialog).toHaveTextContent('people using chat know it will pause during the switch-over, usually for a few minutes.');
  });

  it('the Node.js tick adds its step and travels with the typed phrase and the good-time acknowledgement', async () => {
    const { user, dialog } = await openReview();
    await user.click(within(dialog).getByLabelText(/Also update Node\.js/));
    expect(within(dialog).getByRole('list', { name: 'What will happen' })).toHaveTextContent('Node.js is updated to the newest 24.x release');
    await user.type(within(dialog).getByRole('textbox'), 'UPDATE OPENCLAW');
    await user.click(within(dialog).getByLabelText(/This is a good time/));
    await user.click(within(dialog).getByRole('button', { name: 'Update OpenClaw' }));
    expect(api.startRun).toHaveBeenCalledWith({
      tool: 'openclaw', action: 'update', target: 'recommended', channel: null, confirmation: 'UPDATE OPENCLAW',
      maintenanceWindowAcknowledged: true, acknowledgements: { nodeRuntime: true },
    });
  });

  it('without the good-time acknowledgement nothing starts; without the tick no Node.js step is requested', async () => {
    const { user, dialog } = await openReview();
    await user.type(within(dialog).getByRole('textbox'), 'UPDATE OPENCLAW');
    await user.click(within(dialog).getByRole('button', { name: 'Update OpenClaw' }));
    expect(api.startRun).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Confirm that this is a good time for the OpenClaw restart before starting.');
    await user.click(within(dialog).getByLabelText(/This is a good time/));
    await user.click(within(dialog).getByRole('button', { name: 'Update OpenClaw' }));
    expect(api.startRun).toHaveBeenCalledWith(expect.not.objectContaining({ acknowledgements: expect.anything() }));
  });

  it('without a fresh passing pre-flight, Update runs the pre-flight first and opens no review (N2)', async () => {
    for (const preflightPassedAt of [null, new Date(Date.now() - 31 * 60_000).toISOString()]) {
      api.startRun.mockClear();
      api.getStatus.mockResolvedValue(toolsStatus({ tools: [openclawItem({ preflightPassedAt }), toolItem()] }));
      const user = userEvent.setup();
      const { unmount } = render(<AiToolsPanel owner backup={BACKUP} />);
      await user.click(await screen.findByRole('button', { name: 'Update OpenClaw to 2026.10.9' }));
      expect(api.startRun).toHaveBeenCalledWith({ tool: 'openclaw', action: 'preflight', channel: null });
      expect(api.startRun).toHaveBeenCalledTimes(1);
      expect(await screen.findByText(/Checking whether OpenClaw can update first, so the review can say whether chat stays up\. Nothing is changed\./))
        .toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: 'Review the OpenClaw update' })).toBeNull();
      unmount();
    }
    // A pre-flight that passed 29 minutes ago is fresh: the review opens and nothing starts.
    api.startRun.mockClear();
    api.getStatus.mockResolvedValue(toolsStatus({
      tools: [openclawItem({ preflightPassedAt: new Date(Date.now() - 29 * 60_000).toISOString() }), toolItem()],
    }));
    const { dialog } = await openReview();
    expect(dialog).toBeInTheDocument();
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it('without a verified backup the review says to create one first', async () => {
    const { dialog } = await openReview(null);
    expect(within(dialog).getByTestId('openclaw-consent-backup')).toHaveTextContent('no verified maintenance backup was found. Create one before starting');
  });

  it('the "update with Node.js" next step opens the review with the tick already set', async () => {
    api.getStatus.mockResolvedValue(toolsStatus({
      tools: [openclawItem({ lastRun: {
        runId: 'r0', action: 'update', state: 'refused', startedAt: null, endedAt: null, errorId: 'PF7_NODE_TOO_OLD',
        message: 'Node.js 24.21.0 must be updated to satisfy OpenClaw 2026.10.9.', nextAction: 'node-runtime', from: '2026.9.9', to: null, refusals: [],
      } }), toolItem()],
    }));
    const user = userEvent.setup();
    render(<AiToolsPanel owner backup={BACKUP} />);
    await user.click(await screen.findByRole('button', { name: 'Review the update with Node.js' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review the OpenClaw update' });
    expect(within(dialog).getByLabelText(/Also update Node\.js/)).toBeChecked();
  });
});
