// @vitest-environment jsdom
import '../test/setup';
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationsContent } from './AutomationsPage';

vi.mock('framer-motion', async () => {
  const ReactModule = await import('react');
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: {
      div: ReactModule.forwardRef<HTMLDivElement, Record<string, unknown>>((props, ref) => {
        const {
          children,
          initial: _initial,
          animate: _animate,
          exit: _exit,
          transition: _transition,
          variants: _variants,
          layout: _layout,
          ...domProps
        } = props;
        return <div ref={ref} {...domProps}>{children as React.ReactNode}</div>;
      }),
    },
  };
});

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  toggle: vi.fn(),
  remove: vi.fn(),
  runNow: vi.fn(),
  runs: vi.fn(),
  models: vi.fn(),
}));

vi.mock('../api/endpoints', () => ({
  automationsAPI: {
    list: mocks.list,
    create: mocks.create,
    update: mocks.update,
    toggle: mocks.toggle,
    remove: mocks.remove,
    runNow: mocks.runNow,
    runs: mocks.runs,
  },
  gatewayAPI: { models: mocks.models },
}));

const agentJob = {
  id: 'agent-job',
  name: 'Agent job',
  enabled: true,
  agentId: 'main',
  sessionTarget: 'isolated',
  schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' },
  payload: { kind: 'agentTurn', message: 'Prepare report', model: 'openai/gpt-5.5', thinking: 'high' },
  state: {},
};

const commandJob = {
  id: 'command-job',
  name: 'OpenClaw command job',
  enabled: true,
  sessionTarget: 'isolated',
  schedule: { kind: 'cron', expr: '0 3 * * *', tz: 'UTC' },
  payload: { kind: 'command' },
  state: {},
};

const secondAgentJob = {
  ...agentJob,
  id: 'agent-job-two',
  name: 'Second agent job',
  enabled: false,
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Automations editor contract', () => {
  beforeEach(() => {
    mocks.list.mockReset().mockResolvedValue({ jobs: [agentJob, commandJob] });
    mocks.create.mockReset().mockResolvedValue({ ok: true });
    mocks.update.mockReset().mockResolvedValue({ ok: true });
    mocks.toggle.mockReset().mockResolvedValue({ ok: true });
    mocks.remove.mockReset().mockResolvedValue({ ok: true });
    mocks.runNow.mockReset().mockResolvedValue({ ok: true, runId: 'run-1' });
    mocks.runs.mockReset().mockResolvedValue({ runs: [] });
    mocks.models.mockReset().mockResolvedValue({
      models: [{ id: 'openai/gpt-5.5', alias: null, displayName: 'GPT-5.5' }],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps non-agent cron payloads read-only and clears optional overrides explicitly', async () => {
    const user = userEvent.setup();
    render(<AutomationsContent showHeader />);

    expect(await screen.findByText('OpenClaw command job')).toBeVisible();
    expect(screen.getByRole('button', { name: 'OpenClaw command job must be edited in OpenClaw' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Disable OpenClaw command job' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'OpenClaw command job must be managed in OpenClaw' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'OpenClaw command job cannot be deleted from the Portal' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Edit Agent job' }));
    expect(await screen.findByRole('dialog', { name: 'Edit Automation' })).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Automation model'), '');
    await user.selectOptions(screen.getByLabelText('Automation thinking level'), 'off');
    const editDialog = screen.getByRole('dialog', { name: 'Edit Automation' });
    const saveButton = within(editDialog).getByRole('button', { name: 'Save Changes' });
    const editForm = document.getElementById('automation-editor-form');
    act(() => {
      saveButton.click();
      editForm!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      saveButton.click();
    });

    await waitFor(() => {
      expect(mocks.update).toHaveBeenCalledTimes(1);
      expect(mocks.update).toHaveBeenCalledWith('agent-job', expect.objectContaining({
        model: null,
        thinking: null,
        schedule: undefined,
        scheduleType: 'daily',
        time: '09:00',
        tz: 'UTC',
      }));
    });
  });

  it('owns create progress synchronously and blocks duplicate submits or dismissal until it settles', async () => {
    const user = userEvent.setup();
    const pendingCreate = deferred<{ ok: boolean }>();
    mocks.create.mockReturnValueOnce(pendingCreate.promise);
    const { container } = render(<AutomationsContent showHeader />);

    const trigger = await screen.findByRole('button', { name: 'New Automation' });
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'New Automation' });
    await waitFor(() => expect(screen.getByLabelText('Automation name')).toHaveFocus());
    expect(container).toHaveAttribute('inert');
    expect(container).toHaveAttribute('aria-hidden', 'true');

    await user.type(screen.getByLabelText('Automation name'), 'Morning report');
    await user.type(screen.getByLabelText('Automation prompt or task'), 'Prepare the morning report');

    const form = document.getElementById('automation-editor-form');
    expect(form).not.toBeNull();
    const createButton = within(dialog).getByRole('button', { name: 'Create' });
    act(() => {
      createButton.click();
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      createButton.click();
    });

    expect(mocks.create).toHaveBeenCalledTimes(1);
    const busyButton = await screen.findByRole('button', { name: 'Creating…' });
    expect(busyButton).toBeDisabled();
    expect(busyButton).toHaveAttribute('aria-busy', 'true');

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(dialog.closest('[data-viewport-modal-layer="true"]')!);
    expect(screen.getByRole('dialog', { name: 'New Automation' })).toBeVisible();

    await act(async () => {
      pendingCreate.resolve({ ok: true });
      await pendingCreate.promise;
    });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New Automation' })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('keeps create failures in the editor and restores a usable primary action', async () => {
    const user = userEvent.setup();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.create.mockRejectedValueOnce({ response: { data: { error: 'Schedule could not be saved' } } });
    render(<AutomationsContent showHeader />);

    await user.click(await screen.findByRole('button', { name: 'New Automation' }));
    const dialog = await screen.findByRole('dialog', { name: 'New Automation' });
    await user.type(screen.getByLabelText('Automation name'), 'Broken schedule');
    await user.type(screen.getByLabelText('Automation prompt or task'), 'Try the failing schedule');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Schedule could not be saved');
    const retryButton = within(dialog).getByRole('button', { name: 'Create' });
    expect(retryButton).toBeEnabled();
    expect(retryButton).toHaveAttribute('aria-busy', 'false');
    expect(screen.getAllByText('Schedule could not be saved')).toHaveLength(1);
  });

  it('keeps delete progress and errors in its dialog with a same-frame single-flight guard', async () => {
    const user = userEvent.setup();
    const pendingDelete = deferred<{ ok: boolean }>();
    mocks.remove.mockReturnValueOnce(pendingDelete.promise);
    render(<AutomationsContent showHeader />);

    await user.click(await screen.findByRole('button', { name: 'Delete Agent job' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Automation?' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus());

    const deleteButton = within(dialog).getByRole('button', { name: 'Delete' });
    act(() => {
      deleteButton.click();
      dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      deleteButton.click();
    });
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(await within(dialog).findByRole('button', { name: 'Deleting…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getAllByText('Deleting…')).toHaveLength(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(dialog.closest('[data-viewport-modal-layer="true"]')!);
    expect(screen.getByRole('dialog', { name: 'Delete Automation?' })).toBeVisible();

    await act(async () => {
      pendingDelete.reject({ response: { data: { error: 'Deletion was refused' } } });
      await pendingDelete.promise.catch(() => undefined);
    });

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Deletion was refused');
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeEnabled();
    expect(screen.getByRole('dialog', { name: 'Delete Automation?' })).toBeVisible();

    mocks.list.mockResolvedValue({ jobs: [commandJob] });
    mocks.remove.mockResolvedValueOnce({ ok: true });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete Automation?' })).not.toBeInTheDocument());
    expect(mocks.remove).toHaveBeenCalledTimes(2);
  });

  it('gives the run-history drawer modal focus ownership and dismisses nested surfaces in LIFO order', async () => {
    const user = userEvent.setup();
    const { container } = render(<AutomationsContent showHeader />);

    const historyTrigger = await screen.findByRole('button', { name: 'View runs for Agent job' });
    const editTrigger = screen.getByRole('button', { name: 'Edit Agent job' });
    await user.click(historyTrigger);

    expect(await screen.findByRole('dialog', { name: 'Run History' })).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close run history' })).toHaveFocus());
    expect(container).toHaveAttribute('inert');

    fireEvent.click(editTrigger);
    expect(await screen.findByRole('dialog', { name: 'Edit Automation' })).toBeVisible();
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(2);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit Automation' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Run History' })).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close run history' })).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Run History' })).not.toBeInTheDocument());
    await waitFor(() => expect(historyTrigger).toHaveFocus());
    expect(container).not.toHaveAttribute('inert');
    expect(container).not.toHaveAttribute('aria-hidden');
  });

  it('single-flights run-now and blocks same-frame cross-row or toggle mutations', async () => {
    const pendingRun = deferred<{ ok: boolean; runId: string }>();
    mocks.list.mockResolvedValue({ jobs: [agentJob, secondAgentJob] });
    mocks.runNow.mockReturnValueOnce(pendingRun.promise);
    render(<AutomationsContent showHeader />);

    const firstRun = await screen.findByRole('button', { name: 'Run Agent job now' });
    const secondRun = screen.getByRole('button', { name: 'Run Second agent job now' });
    const firstToggle = screen.getByRole('switch', { name: 'Disable Agent job' });
    const create = screen.getByRole('button', { name: 'New Automation' });
    act(() => {
      firstRun.click();
      firstRun.click();
      secondRun.click();
      firstToggle.click();
      create.click();
    });

    expect(mocks.runNow).toHaveBeenCalledTimes(1);
    expect(mocks.runNow).toHaveBeenCalledWith('agent-job');
    expect(mocks.toggle).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'New Automation' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Running Agent job…' })).toHaveAttribute('aria-busy', 'true');
    expect(secondRun).toBeDisabled();
    expect(firstToggle).toBeDisabled();
    expect(create).toBeDisabled();

    await act(async () => {
      pendingRun.resolve({ ok: true, runId: 'run-1' });
      await pendingRun.promise;
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run Agent job now' })).toBeEnabled());
    expect(secondRun).toBeEnabled();
    expect(firstToggle).toBeEnabled();
    expect(create).toBeEnabled();
  });

  it('single-flights toggle, owns its error, and restores all card actions for retry', async () => {
    const pendingToggle = deferred<{ ok: boolean }>();
    mocks.list.mockResolvedValue({ jobs: [agentJob, secondAgentJob] });
    mocks.toggle.mockReturnValueOnce(pendingToggle.promise);
    render(<AutomationsContent showHeader />);

    const toggle = await screen.findByRole('switch', { name: 'Disable Agent job' });
    const secondRun = screen.getByRole('button', { name: 'Run Second agent job now' });
    act(() => {
      toggle.click();
      toggle.click();
      secondRun.click();
    });

    expect(mocks.toggle).toHaveBeenCalledTimes(1);
    expect(mocks.toggle).toHaveBeenCalledWith('agent-job', false);
    expect(mocks.runNow).not.toHaveBeenCalled();
    expect(await screen.findByRole('switch', { name: 'Disabling Agent job…' })).toHaveAttribute('aria-busy', 'true');
    expect(secondRun).toBeDisabled();

    await act(async () => {
      pendingToggle.reject({ response: { data: { error: 'Gateway refused the toggle' } } });
      await pendingToggle.promise.catch(() => undefined);
    });
    expect(await screen.findByText('Gateway refused the toggle')).toBeVisible();
    expect(screen.getByRole('switch', { name: 'Disable Agent job' })).toBeEnabled();
    expect(secondRun).toBeEnabled();

    mocks.toggle.mockResolvedValueOnce({ ok: true });
    await userEvent.click(screen.getByRole('switch', { name: 'Disable Agent job' }));
    await waitFor(() => expect(mocks.toggle).toHaveBeenCalledTimes(2));
  });
});
