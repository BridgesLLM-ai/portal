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

  it('keeps positive automation mutations unavailable while preserving disable and delete controls', async () => {
    render(<AutomationsContent showHeader />);

    expect(await screen.findByText('OpenClaw command job')).toBeVisible();
    expect(screen.getByRole('button', { name: 'OpenClaw command job must be edited in OpenClaw' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Disable OpenClaw command job' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'OpenClaw command job must be managed in OpenClaw' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'OpenClaw command job cannot be deleted from the Portal' })).toBeDisabled();

    expect(screen.getByRole('button', { name: 'New Automation' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit Agent job' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run Agent job now' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Disable Agent job' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete Agent job' })).toBeEnabled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('does not open or submit the disabled new-automation entry point', async () => {
    render(<AutomationsContent showHeader />);

    const trigger = await screen.findByRole('button', { name: 'New Automation' });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute('title', expect.stringContaining('unavailable until Portal can supervise'));
    fireEvent.click(trigger);
    expect(screen.queryByRole('dialog', { name: 'New Automation' })).not.toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('keeps the empty-state create entry point disabled without posting', async () => {
    mocks.list.mockResolvedValue({ jobs: [] });
    render(<AutomationsContent showHeader />);

    expect(await screen.findByText('No Automations Yet')).toBeVisible();
    const trigger = screen.getByRole('button', { name: 'Create Your First Automation' });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute('title', expect.stringContaining('unavailable until Portal can supervise'));
    fireEvent.click(trigger);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'New Automation' })).not.toBeInTheDocument();
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

  it('gives run history modal focus ownership while edit remains unavailable', async () => {
    const user = userEvent.setup();
    const { container } = render(<AutomationsContent showHeader />);

    const historyTrigger = await screen.findByRole('button', { name: 'View runs for Agent job' });
    const editTrigger = screen.getByRole('button', { name: 'Edit Agent job' });
    await user.click(historyTrigger);

    expect(await screen.findByRole('dialog', { name: 'Run History' })).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close run history' })).toHaveFocus());
    expect(container).toHaveAttribute('inert');

    fireEvent.click(editTrigger);
    expect(editTrigger).toBeDisabled();
    expect(screen.queryByRole('dialog', { name: 'Edit Automation' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Run History' })).toBeVisible();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Run History' })).not.toBeInTheDocument());
    await waitFor(() => expect(historyTrigger).toHaveFocus());
    expect(container).not.toHaveAttribute('inert');
    expect(container).not.toHaveAttribute('aria-hidden');
  });

  it('keeps run-now, enable, and create starts disabled across rows', async () => {
    mocks.list.mockResolvedValue({ jobs: [agentJob, secondAgentJob] });
    render(<AutomationsContent showHeader />);

    const firstRun = await screen.findByRole('button', { name: 'Run Agent job now' });
    const secondRun = screen.getByRole('button', { name: 'Run Second agent job now' });
    const secondToggle = screen.getByRole('switch', { name: 'Enable Second agent job' });
    const create = screen.getByRole('button', { name: 'New Automation' });
    expect(firstRun).toBeDisabled();
    expect(secondRun).toBeDisabled();
    expect(secondToggle).toBeDisabled();
    expect(create).toBeDisabled();
    fireEvent.click(firstRun);
    fireEvent.click(secondRun);
    fireEvent.click(secondToggle);
    fireEvent.click(create);
    expect(mocks.runNow).not.toHaveBeenCalled();
    expect(mocks.toggle).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'New Automation' })).not.toBeInTheDocument();
  });

  it('single-flights permitted disable, owns its error, and keeps positive run fenced', async () => {
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
    expect(secondRun).toBeDisabled();

    mocks.toggle.mockResolvedValueOnce({ ok: true });
    await userEvent.click(screen.getByRole('switch', { name: 'Disable Agent job' }));
    await waitFor(() => expect(mocks.toggle).toHaveBeenCalledTimes(2));
  });
});
