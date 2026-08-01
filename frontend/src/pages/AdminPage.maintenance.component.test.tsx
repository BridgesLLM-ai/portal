// @vitest-environment jsdom
import '../test/setup';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminPage from './AdminPage';

const adminMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  startAction: vi.fn(),
  listJobs: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuthStore: () => ({
    user: { id: 'owner-1', email: 'owner@example.com', username: 'owner', role: 'OWNER' },
  }),
}));

vi.mock('../api/maintenance', () => ({
  maintenanceAPI: {
    getStatus: adminMocks.getStatus,
    startAction: adminMocks.startAction,
  },
}));

vi.mock('../api/agentJobs', () => ({
  agentJobsAPI: { list: adminMocks.listJobs },
}));

vi.mock('../api/admin', () => ({ adminAPI: {} }));

vi.mock('../utils/sounds', () => ({
  default: { click: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock('./settingsAdminContract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./settingsAdminContract')>();
  return {
    ...actual,
    maintenancePollDelayMs: (input: { retryAfterMs?: number | null }) => input.retryAfterMs ? 80 : 10,
  };
});

const guardedAction = {
  id: 'apply-security-updates',
  label: 'Apply security updates',
  description: 'Install the reviewed security update set.',
  risk: 'scheduled' as const,
  downtimeExpected: true,
  requiresOwner: true,
  changesSystem: true,
  destructive: false,
  requiresBackup: true,
  requiresMaintenanceWindow: true,
  automationLevel: 'guarded' as const,
  impact: 'Services may restart.',
  recovery: 'Restore the verified backup.',
  confirmationPhrase: 'APPLY SECURITY UPDATES',
};

const maintenanceStatus = {
  ready: true,
  checkedAt: '2026-07-19T08:00:00.000Z',
  status: 'warning' as const,
  summary: 'Updates require an approved maintenance window.',
  host: { hostname: 'portal-test', os: 'Test Linux', kernel: '6.8.0', uptimeSeconds: 3600 },
  issues: [],
  actions: [guardedAction],
  compatibility: { policy: 'guarded' as const, summary: 'Verified compatibility manifest.', components: [] },
  backup: { path: '/var/backups/portal.tar.gz', createdAt: '2026-07-19T07:00:00.000Z', ageHours: 1 },
  reboot: { required: false, packages: [] },
};

const runningMaintenanceJob = {
  id: 'job-1',
  userId: 'owner-1',
  toolId: 'system-maintenance',
  title: 'Apply security updates',
  status: 'running' as const,
  createdAt: '2026-07-19T08:01:00.000Z',
  updatedAt: '2026-07-19T08:01:00.000Z',
  startedAt: '2026-07-19T08:01:00.000Z',
  finishedAt: null,
  exitCode: null,
};

describe('AdminPage maintenance admission surface', () => {
  beforeEach(() => {
    adminMocks.getStatus.mockReset().mockResolvedValue(maintenanceStatus);
    adminMocks.startAction.mockReset().mockResolvedValue({ job: runningMaintenanceJob });
    adminMocks.listJobs.mockReset().mockResolvedValue([]);
  });

  it('requires both the exact phrase and an explicit maintenance-window acknowledgement', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter
        initialEntries={['/admin?tab=maintenance']}
      >
        <AdminPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Available Actions' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Run' }));

    expect(screen.getByRole('dialog', { name: 'Apply security updates' })).toBeVisible();
    const confirmation = screen.getByRole('textbox', { name: /Type APPLY SECURITY UPDATES to continue/i });
    const startButton = screen.getByRole('button', { name: 'Start server change' });
    expect(confirmation).toHaveFocus();
    expect(startButton).toBeDisabled();

    await user.type(confirmation, 'APPLY SECURITY UPDATES');
    expect(startButton).toBeEnabled();
    await user.click(startButton);

    expect(await screen.findByText(/Confirm that an approved maintenance window is active/i)).toBeVisible();
    expect(adminMocks.startAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('checkbox', { name: /approved maintenance window is active/i }));
    adminMocks.listJobs.mockResolvedValue([runningMaintenanceJob]);
    await user.click(startButton);

    await waitFor(() => {
      expect(adminMocks.startAction).toHaveBeenCalledWith(
        'apply-security-updates',
        'APPLY SECURITY UPDATES',
        true,
      );
    });
    expect(await screen.findByText('Apply security updates is running')).toBeVisible();
    expect(screen.getByText(/protected background job/i)).toBeVisible();
    expect(screen.getByRole('link', { name: 'View progress' })).toHaveAttribute('href', '/tasks');
  });

  it('locks a server-change submission immediately and does not create duplicate jobs', async () => {
    const user = userEvent.setup();
    let resolveStart!: (value: { job: typeof runningMaintenanceJob }) => void;
    adminMocks.startAction.mockImplementation(() => new Promise((resolve) => {
      resolveStart = resolve;
    }));

    render(
      <MemoryRouter
        initialEntries={['/admin?tab=maintenance']}
      >
        <AdminPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Available Actions' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await user.type(
      screen.getByRole('textbox', { name: /Type APPLY SECURITY UPDATES to continue/i }),
      'APPLY SECURITY UPDATES',
    );
    await user.click(screen.getByRole('checkbox', { name: /approved maintenance window is active/i }));

    const startButton = screen.getByRole('button', { name: 'Start server change' });
    await user.dblClick(startButton);

    expect(adminMocks.startAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Starting server change…' })).toBeDisabled();
    expect(screen.getByText(/Validating safeguards and creating one protected background job/i)).toBeVisible();

    adminMocks.listJobs.mockResolvedValue([runningMaintenanceJob]);
    resolveStart({ job: runningMaintenanceJob });
    expect(await screen.findByText('Apply security updates is running')).toBeVisible();
    expect(adminMocks.startAction).toHaveBeenCalledTimes(1);
  });

  it('keeps polling until a running maintenance job reaches completion', async () => {
    const user = userEvent.setup();
    const completedMaintenanceJob = {
      ...runningMaintenanceJob,
      status: 'completed' as const,
      updatedAt: '2026-07-19T08:01:04.000Z',
      finishedAt: '2026-07-19T08:01:04.000Z',
      exitCode: 0,
    };
    let jobStarted = false;
    let postStartPolls = 0;
    adminMocks.startAction.mockImplementation(async () => {
      jobStarted = true;
      return { job: runningMaintenanceJob };
    });
    adminMocks.listJobs.mockImplementation(async () => {
      if (!jobStarted) return [];
      postStartPolls += 1;
      return postStartPolls >= 3 ? [completedMaintenanceJob] : [runningMaintenanceJob];
    });

    render(
      <MemoryRouter
        initialEntries={['/admin?tab=maintenance']}
      >
        <AdminPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Available Actions' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await user.type(
      screen.getByRole('textbox', { name: /Type APPLY SECURITY UPDATES to continue/i }),
      'APPLY SECURITY UPDATES',
    );
    await user.click(screen.getByRole('checkbox', { name: /approved maintenance window is active/i }));
    await user.click(screen.getByRole('button', { name: 'Start server change' }));

    expect(await screen.findByText('Apply security updates is running')).toBeVisible();
    expect(await screen.findByText('Apply security updates completed')).toBeVisible();
    expect(postStartPolls).toBeGreaterThanOrEqual(3);
  });

  it('keeps a failed start safe to review and retry through the confirmation gate', async () => {
    const user = userEvent.setup();
    adminMocks.startAction.mockRejectedValueOnce(new Error('Package manager preflight failed'));
    render(
      <MemoryRouter
        initialEntries={['/admin?tab=maintenance']}
      >
        <AdminPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Available Actions' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Run' }));
    const confirmation = screen.getByRole('textbox', { name: /Type APPLY SECURITY UPDATES to continue/i });
    await user.type(confirmation, 'APPLY SECURITY UPDATES');
    await user.click(screen.getByRole('checkbox', { name: /approved maintenance window is active/i }));
    await user.click(screen.getByRole('button', { name: 'Start server change' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Package manager preflight failed');
    expect(screen.getByRole('button', { name: 'Start server change' })).toBeEnabled();

    adminMocks.startAction.mockResolvedValueOnce({ job: runningMaintenanceJob });
    adminMocks.listJobs.mockResolvedValue([runningMaintenanceJob]);
    await user.click(screen.getByRole('button', { name: 'Start server change' }));
    await waitFor(() => expect(adminMocks.startAction).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Apply security updates is running')).toBeVisible();
  });

  it('shows persistent refresh failures honestly and waits for the advertised retry window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const failedStatus = {
      ...maintenanceStatus,
      ready: false,
      cached: false,
      refreshing: false,
      checkedAt: null,
      refreshError: 'Package metadata probe failed',
      retryAfterMs: 60_000,
      status: 'warning' as const,
      summary: 'Server checks are paused after a failed refresh.',
      host: undefined,
    };
    adminMocks.getStatus.mockResolvedValue(failedStatus);

    const view = render(
      <MemoryRouter
        initialEntries={['/admin?tab=maintenance']}
      >
        <AdminPage />
      </MemoryRouter>,
    );

    try {
      await act(async () => {});
      expect(screen.getByRole('alert')).toHaveTextContent('Package metadata probe failed');
      expect(screen.getByRole('alert')).toHaveTextContent('paused for 1 minute');
      expect(screen.getByRole('status')).toHaveTextContent('next automatic attempt is scheduled in 1 minute');
      expect(screen.queryByText(/checks are running in the background/i)).not.toBeInTheDocument();

      await act(async () => { vi.advanceTimersByTime(79); });
      expect(adminMocks.getStatus).toHaveBeenCalledTimes(1);
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(adminMocks.getStatus).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
});
