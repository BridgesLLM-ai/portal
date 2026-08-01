// @vitest-environment jsdom
import '../test/setup';
import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TasksPage from './TasksPage';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

vi.mock('framer-motion', async () => {
  const ReactModule = await import('react');
  return {
    motion: {
      div: ReactModule.forwardRef<HTMLDivElement, Record<string, unknown>>((props, ref) => {
        const {
          children,
          initial: _initial,
          animate: _animate,
          transition: _transition,
          ...domProps
        } = props;
        return <div ref={ref} {...domProps}>{children as React.ReactNode}</div>;
      }),
    },
  };
});

const mocks = vi.hoisted(() => ({
  gatewayGet: vi.fn(),
  listJobs: vi.fn(),
  transcript: vi.fn(),
  kill: vi.fn(),
}));

vi.mock('../api/client', () => ({
  default: { get: mocks.gatewayGet },
}));

vi.mock('../api/agentJobs', () => ({
  agentJobsAPI: {
    list: mocks.listJobs,
    transcript: mocks.transcript,
    kill: mocks.kill,
  },
}));

const retainedJob = {
  id: 'job-1',
  userId: 'owner-1',
  toolId: 'system-maintenance',
  title: 'Apply security updates',
  status: 'error' as const,
  createdAt: '2026-07-19T12:00:00.000Z',
  updatedAt: '2026-07-19T12:01:00.000Z',
  startedAt: '2026-07-19T12:00:01.000Z',
  finishedAt: '2026-07-19T12:01:00.000Z',
  exitCode: 1,
};

function NavigationProbe() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <button type="button" onClick={() => navigate('/settings')}>Navigate away</button>
      <output data-testid="task-route">{location.pathname}</output>
    </>
  );
}

function renderRoutedTasks() {
  return render(
    <MemoryRouter
      initialEntries={['/tasks']}
    >
      <NavigationProbe />
      <TasksPage />
    </MemoryRouter>,
  );
}

describe('TasksPage retained job diagnostics', () => {
  beforeEach(() => {
    mocks.gatewayGet.mockReset().mockResolvedValue({ data: { ok: true, tasks: [] } });
    mocks.listJobs.mockReset().mockResolvedValue([retainedJob]);
    mocks.transcript.mockReset().mockResolvedValue([
      {
        type: 'output',
        stream: 'stderr',
        text: 'apt lock could not be acquired',
        timestamp: '2026-07-19T12:00:30.000Z',
      },
      {
        type: 'system',
        text: 'Job exited with code 1.',
        timestamp: '2026-07-19T12:01:00.000Z',
      },
    ]);
    mocks.kill.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => vi.useRealTimers());

  it('keeps successful Portal jobs visible when the OpenClaw task source fails', async () => {
    mocks.gatewayGet.mockRejectedValue(new Error('gateway unavailable'));

    render(<TasksPage />);

    expect(await screen.findByText('Apply security updates')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Some task sources are unavailable: gateway unavailable',
    );
    expect(screen.queryByText('Failed to load tasks')).not.toBeInTheDocument();
  });

  it('owns the vertical scroll container inside the fixed-height Portal shell', async () => {
    const { container } = render(<TasksPage />);
    expect(await screen.findByText('Apply security updates')).toBeVisible();
    expect(container.firstElementChild).toHaveClass('h-full', 'min-h-0', 'overflow-y-auto', 'overscroll-contain');
  });

  it('loads only the bounded retained transcript when a job is expanded', async () => {
    const user = userEvent.setup();
    render(<TasksPage />);

    expect(await screen.findByText('Apply security updates')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Details' }));

    await waitFor(() => {
      expect(mocks.transcript).toHaveBeenCalledWith('job-1', 200);
    });
    expect(await screen.findByText(/\[stderr\] apt lock could not be acquired/)).toBeVisible();
    expect(screen.getByText(/\[system\] Job exited with code 1\./)).toBeVisible();
  });

  it('surfaces degraded gateway snapshots even when fallback tasks are available', async () => {
    mocks.gatewayGet.mockResolvedValue({
      data: { ok: true, tasks: [], warning: 'tasks.list unavailable; using sessions' },
    });
    render(<TasksPage />);
    expect(await screen.findByText('Apply security updates')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('tasks.list unavailable; using sessions');
  });

  it('requires typed confirmation before cancelling a running retained job', async () => {
    const user = userEvent.setup();
    const running = { ...retainedJob, status: 'running' as const, finishedAt: null, exitCode: null };
    mocks.listJobs.mockReset()
      .mockResolvedValueOnce([running])
      .mockResolvedValue([{ ...running, status: 'killed' as const, finishedAt: '2026-07-19T12:01:00.000Z' }]);
    render(<TasksPage />);

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    const cancelButton = screen.getByRole('button', { name: 'Cancel job' });
    expect(cancelButton).toBeDisabled();
    await user.type(screen.getByLabelText(/Type .*CANCEL JOB job-1.* to continue/i), 'CANCEL JOB job-1');
    await user.click(cancelButton);

    await waitFor(() => expect(mocks.kill).toHaveBeenCalledWith('job-1', { timeoutMs: 15000 }));
    expect(mocks.listJobs).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cancel Apply security updates' })).not.toBeInTheDocument());
  });

  it('leases cancellation to one immutable job across same-frame and cross-row attempts', async () => {
    const user = userEvent.setup();
    const killGate = deferred<void>();
    const first = { ...retainedJob, id: 'job-1', title: 'First running job', status: 'running' as const, finishedAt: null, exitCode: null };
    const second = { ...retainedJob, id: 'job-2', title: 'Second running job', status: 'running' as const, finishedAt: null, exitCode: null };
    mocks.listJobs.mockReset()
      .mockResolvedValueOnce([first, second])
      .mockResolvedValue([{ ...first, status: 'killed' as const }, second]);
    mocks.kill.mockReturnValueOnce(killGate.promise);
    render(<TasksPage />);

    expect(await screen.findByText('First running job')).toBeVisible();
    const rowCancelButtons = screen.getAllByRole('button', { name: 'Cancel' });
    await user.click(rowCancelButtons[0]);
    await user.type(screen.getByLabelText(/Type .*CANCEL JOB job-1.* to continue/i), 'CANCEL JOB job-1');
    const confirm = screen.getByRole('button', { name: 'Cancel job' });

    act(() => {
      confirm.click();
      confirm.click();
      rowCancelButtons[1].click();
    });

    expect(mocks.kill).toHaveBeenCalledTimes(1);
    expect(mocks.kill).toHaveBeenCalledWith('job-1', { timeoutMs: 15000 });
    const dialog = screen.getByRole('dialog', { name: 'Cancel First running job' });
    expect(dialog).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Cancelling job…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Close confirmation dialog' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Cancel First running job' })).toBeVisible();

    killGate.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cancel First running job' })).not.toBeInTheDocument());
    expect(mocks.kill).toHaveBeenCalledTimes(1);
  });

  it('keeps cancellation failure with the leased job and permits a deliberate retry', async () => {
    const user = userEvent.setup();
    const running = { ...retainedJob, status: 'running' as const, finishedAt: null, exitCode: null };
    mocks.listJobs.mockReset()
      .mockResolvedValueOnce([running])
      .mockResolvedValue([{ ...running, status: 'killed' as const }]);
    mocks.kill
      .mockRejectedValueOnce(new Error('termination acknowledgement unavailable'))
      .mockResolvedValueOnce(undefined);
    render(<TasksPage />);

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await user.type(screen.getByLabelText(/Type .*CANCEL JOB job-1.* to continue/i), 'CANCEL JOB job-1');
    await user.click(screen.getByRole('button', { name: 'Cancel job' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('termination acknowledgement unavailable');
    expect(screen.getByRole('dialog', { name: 'Cancel Apply security updates' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel job' }));

    await waitFor(() => expect(mocks.kill).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cancel Apply security updates' })).not.toBeInTheDocument());
  });

  it('fails closed on rejected retained-job readback and retries proof without another kill', async () => {
    const user = userEvent.setup();
    const running = { ...retainedJob, status: 'running' as const, finishedAt: null, exitCode: null };
    mocks.listJobs.mockReset()
      .mockResolvedValueOnce([running])
      .mockRejectedValueOnce(new Error('retained inventory unavailable'))
      .mockResolvedValue([{ ...running, status: 'killed' as const }]);
    render(<TasksPage />);

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await user.type(screen.getByLabelText(/Type .*CANCEL JOB job-1.* to continue/i), 'CANCEL JOB job-1');
    await user.click(screen.getByRole('button', { name: 'Cancel job' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('retained inventory unavailable');
    expect(screen.getByRole('button', { name: 'Retry verification' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Retry verification' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cancel Apply security updates' })).not.toBeInTheDocument());
    expect(mocks.kill).toHaveBeenCalledTimes(1);
  });

  it('bounds an unresolved retained-job inventory request and leaves cancellation visible', async () => {
    const user = userEvent.setup();
    const running = { ...retainedJob, status: 'running' as const, finishedAt: null, exitCode: null };
    mocks.listJobs.mockReset().mockImplementation((options?: { timeoutMs?: number }) => (
      options ? new Promise(() => undefined) : Promise.resolve([running])
    ));
    render(<TasksPage />);

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await user.type(screen.getByLabelText(/Type .*CANCEL JOB job-1.* to continue/i), 'CANCEL JOB job-1');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    screen.getByRole('button', { name: 'Cancel job' }).click();
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    vi.useRealTimers();

    expect(await screen.findByRole('alert')).toHaveTextContent('retained-job inventory did not answer');
    expect(screen.getByRole('dialog', { name: 'Cancel Apply security updates' })).toBeVisible();
    expect(mocks.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale running readback after the overall cancellation deadline', async () => {
    const user = userEvent.setup();
    const running = { ...retainedJob, status: 'running' as const, finishedAt: null, exitCode: null };
    mocks.listJobs.mockReset().mockResolvedValue([running]);
    render(<TasksPage />);

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await user.type(screen.getByLabelText(/Type .*CANCEL JOB job-1.* to continue/i), 'CANCEL JOB job-1');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    screen.getByRole('button', { name: 'Cancel job' }).click();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    vi.useRealTimers();

    expect(await screen.findByRole('alert')).toHaveTextContent('still reports running after 20 seconds');
    expect(screen.getByRole('button', { name: 'Retry verification' })).toBeEnabled();
    expect(mocks.kill).toHaveBeenCalledTimes(1);
  });

  it('blocks router, browser-history, and unload navigation for the full cancellation lease', async () => {
    const user = userEvent.setup();
    const killGate = deferred<void>();
    const running = { ...retainedJob, status: 'running' as const, finishedAt: null, exitCode: null };
    mocks.listJobs.mockReset()
      .mockResolvedValueOnce([running])
      .mockResolvedValue([{ ...running, status: 'killed' as const }]);
    mocks.kill.mockReturnValueOnce(killGate.promise);
    renderRoutedTasks();

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await user.type(screen.getByLabelText(/Type .*CANCEL JOB job-1.* to continue/i), 'CANCEL JOB job-1');
    screen.getByRole('button', { name: 'Cancel job' }).click();
    expect(await screen.findByRole('button', { name: 'Cancelling job…' })).toHaveAttribute('aria-busy', 'true');

    act(() => { screen.getByRole('button', { name: 'Navigate away', hidden: true }).click(); });
    expect(screen.getByTestId('task-route')).toHaveTextContent('/tasks');
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false);
    const pushState = vi.spyOn(window.history, 'pushState');
    act(() => { window.dispatchEvent(new PopStateEvent('popstate', { state: {} })); });
    expect(pushState).toHaveBeenCalled();
    pushState.mockRestore();

    await act(async () => {
      killGate.resolve();
      await killGate.promise;
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cancel Apply security updates' })).not.toBeInTheDocument());
  });
});
