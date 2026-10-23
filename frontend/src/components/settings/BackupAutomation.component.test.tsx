// @vitest-environment jsdom
import '../../test/setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupScheduleSection, BackupStorageLimitsSection, type BackupScheduleView } from './BackupAutomation';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('../../api/client', () => ({ default: mocks }));

const GIB = 1024 ** 3;
const policy = { keep: { daily: 7, weekly: 4, monthly: 3, comprehensive: 3 }, autoCleanup: false, reserveGiB: 5 };
const report = (overrides: Record<string, unknown> = {}) => ({
  policy, source: 'default', defaults: policy, limits: { keep: [1, 100], reserveGiB: [0, 1000] },
  storage: { freeBytes: 80 * GIB, totalBytes: 125 * GIB }, ...overrides,
});
const preview = {
  token: 'f'.repeat(64),
  archives: [
    { name: 'portal-daily-20260901-020000-data-0000000a.tar.gz', type: 'daily', sizeBytes: 44 * GIB, created: '2026-09-01T06:00:00Z' },
    { name: 'portal-daily-20260902-020000-data-0000000b.tar.gz', type: 'daily', sizeBytes: 45 * GIB, created: '2026-09-02T06:00:00Z' },
  ],
  count: 2, totalBytes: 89 * GIB, protected: { newest: 1, locked: 1, pinned: 0 }, unverified: 1,
};

function renderLimits(onBackupsChanged = vi.fn()) {
  const claim = vi.fn(() => true);
  const release = vi.fn();
  render(<BackupStorageLimitsSection claim={claim} release={release} onBackupsChanged={onBackupsChanged} />);
  return { claim, release, onBackupsChanged };
}

describe('backup storage limits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockImplementation(async (url: string) => {
      if (url === '/backups/settings') return { data: report() };
      if (url === '/backups/cleanup/preview') return { data: preview };
      throw new Error(`unexpected GET ${url}`);
    });
  });

  it('saves limits without cleaning up anything', async () => {
    const user = userEvent.setup();
    renderLimits();
    expect(await screen.findByText('Backup disk: 80.0 GB free of 125.0 GB')).toBeVisible();
    const save = screen.getByRole('button', { name: 'Save limits' });
    expect(save).toBeDisabled();
    await user.clear(screen.getByLabelText('Keep daily backups'));
    await user.type(screen.getByLabelText('Keep daily backups'), '2');
    await user.click(screen.getByRole('checkbox', { name: /make room automatically/i }));
    await user.clear(screen.getByLabelText('Free space to keep in GB'));
    await user.type(screen.getByLabelText('Free space to keep in GB'), '12');
    const saved = { ...policy, keep: { ...policy.keep, daily: 2 }, autoCleanup: true, reserveGiB: 12 };
    mocks.put.mockResolvedValue({ data: report({ policy: saved, source: 'saved' }) });
    await user.click(save);
    expect(await screen.findByText(/Saved\. Nothing was deleted/)).toBeVisible();
    expect(mocks.put).toHaveBeenCalledWith('/backups/settings', saved);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalledWith('/backups/cleanup/preview');
  });

  it('blocks values outside the program limits', async () => {
    const user = userEvent.setup();
    renderLimits();
    const daily = await screen.findByLabelText('Keep daily backups');
    await user.clear(daily);
    await user.type(daily, '0');
    expect(screen.getByRole('button', { name: 'Save limits' })).toBeDisabled();
  });

  it('warns when saved limits are unreadable', async () => {
    mocks.get.mockResolvedValueOnce({ data: report({ policy: null, source: 'invalid' }) });
    renderLimits();
    expect(await screen.findByText(/could not be read, so no backups are being removed/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save limits' })).toBeEnabled();
  });

  it('deletes only after the exact list is reviewed and confirmed, and reports measured space', async () => {
    const user = userEvent.setup();
    const { onBackupsChanged } = renderLimits();
    await user.click(await screen.findByRole('button', { name: 'Clean up old backups…' }));
    const region = await screen.findByRole('region', { name: 'Clean up old backups' });
    expect(within(region).getByText('2 backups are over your limits (89.0 GB):')).toBeVisible();
    for (const archive of preview.archives) expect(within(region).getByText(archive.name)).toBeVisible();
    expect(within(region).getByText('Always kept: your newest complete backup, 1 locked.')).toBeVisible();
    expect(within(region).getByText(/1 backup that Portal can't verify is never removed/)).toBeVisible();
    expect(mocks.post).not.toHaveBeenCalled();
    await user.click(within(region).getByRole('button', { name: 'Cancel' }));
    expect(mocks.post).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Clean up old backups…' }));
    mocks.post.mockResolvedValue({ data: { deletedCount: 2, deletedBytes: 89 * GIB, freedBytes: 44 * GIB, heldBytes: 45 * GIB } });
    await user.click(await screen.findByRole('button', { name: 'Delete 2 backups' }));
    expect(mocks.post).toHaveBeenCalledWith('/backups/cleanup', { planToken: preview.token, confirm: true });
    expect(await screen.findByText(/Deleted 2 backups \(89\.0 GB\)\. Free space went up by 44\.0 GB\. 45\.0 GB is still held by an open download/)).toBeVisible();
    await waitFor(() => expect(onBackupsChanged).toHaveBeenCalled());
  });

  it('shows a stale review as an error and does not retry', async () => {
    const user = userEvent.setup();
    renderLimits();
    await user.click(await screen.findByRole('button', { name: 'Clean up old backups…' }));
    mocks.post.mockRejectedValue({ response: { status: 409, data: { code: 'STALE', error: 'Backups changed since you reviewed them. Nothing was deleted; review the cleanup again.' } } });
    await user.click(await screen.findByRole('button', { name: 'Delete 2 backups' }));
    expect(await screen.findByText(/Backups changed since you reviewed them/)).toBeVisible();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region', { name: 'Clean up old backups' })).toBeNull();
  });
});

const schedule = (overrides: Partial<BackupScheduleView>): BackupScheduleView => ({
  type: 'daily', frequency: 'daily', loaded: true, enabled: true, active: true, editable: true,
  onCalendar: '*-*-* 02:00:00', time: '02:00', weekday: null, dayOfMonth: null, customCalendar: null,
  nextRun: 'Fri 2026-10-09 02:00:00 EDT', nextRunAt: '2026-10-09T06:00:00.000Z', ...overrides,
});

describe('automatic backup schedules', () => {
  beforeEach(() => vi.clearAllMocks());

  function renderSchedules(schedules: BackupScheduleView[], onSaved = vi.fn()) {
    render(<BackupScheduleSection schedules={schedules} hostTimezone="America/New_York" error=""
      claim={() => true} release={() => undefined} onSaved={onSaved} />);
    return onSaved;
  }

  it('shows next runs in the server time zone and sends only structured fields', async () => {
    const user = userEvent.setup();
    const onSaved = renderSchedules([
      schedule({}),
      schedule({ type: 'comprehensive', frequency: 'weekly', time: '03:00', weekday: 'Sun', onCalendar: 'Sun *-*-* 03:00:00' }),
      schedule({ type: 'monthly', frequency: 'monthly', time: '04:00', dayOfMonth: 1, onCalendar: '*-*-01 04:00:00' }),
    ]);
    expect(screen.getByText('Server time zone: America/New_York')).toBeVisible();
    expect(screen.getAllByText(/Next: Fri, Oct 9, 2:00\s?AM EDT/)[0]).toBeVisible();
    mocks.put.mockImplementation(async (url: string, body: any) => ({ data: { schedule: schedule({ ...body, type: url.split('/').pop() as any }) } }));

    const dailyTime = screen.getByLabelText('Daily backup time');
    await user.clear(dailyTime);
    await user.type(dailyTime, '03:30');
    const rows = screen.getAllByRole('button', { name: 'Save' });
    await user.click(rows[0]);
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/backups/schedules/daily', { enabled: true, time: '03:30' }));

    await user.click(screen.getByRole('checkbox', { name: 'Weekly comprehensive backup on' }));
    await user.selectOptions(screen.getByLabelText('Weekly comprehensive backup day'), 'Wed');
    await user.click(rows[1]);
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/backups/schedules/comprehensive', { enabled: false, time: '03:00', weekday: 'Wed' }));
    expect(await screen.findByText('Paused. Existing backups are kept.')).toBeVisible();

    await user.selectOptions(screen.getByLabelText('Monthly backup day of month'), '15');
    await user.click(rows[2]);
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/backups/schedules/monthly', { enabled: true, time: '04:00', dayOfMonth: 15 }));
    expect(onSaved).toHaveBeenCalledTimes(3);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('reports a rolled-back change and keeps missing timers read-only', async () => {
    const user = userEvent.setup();
    renderSchedules([schedule({}), schedule({ type: 'monthly', frequency: 'monthly', loaded: false, editable: false })]);
    expect(screen.getByText('Not installed on this server.')).toBeVisible();
    expect(screen.queryByLabelText('Monthly backup time')).toBeNull();
    mocks.put.mockRejectedValue({ response: { status: 502, data: { error: 'The server did not accept the new schedule, so the previous schedule was restored.' } } });
    await user.click(screen.getByRole('checkbox', { name: 'Daily backup on' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/previous schedule was restored/)).toBeVisible();
  });
});
