// @vitest-environment jsdom
import '../../test/setup';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BackupsTab from './BackupsTab';
import { SettingsMutationProvider } from './SettingsMutationContext';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  default: { get: mocks.get, post: mocks.post, delete: mocks.delete },
}));

vi.mock('../../utils/sounds', () => ({
  default: { success: vi.fn(), error: vi.fn(), delete: vi.fn() },
}));

const backup = {
  filename: 'portal-daily-2026-07-21.tar.gz',
  size: 1024,
  sizeHuman: '1 KB',
  created: '2026-07-21T00:00:00.000Z',
  type: 'daily',
  locked: false,
  completeness: 'complete',
  degradedComponents: [],
  classificationAuthenticated: true,
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

function SettingsOwnershipHarness({ children }: { children: ReactNode }) {
  const ownerRef = useRef<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const claim = useCallback((nextOwner: string) => {
    if (ownerRef.current) return false;
    ownerRef.current = nextOwner;
    setOwner(nextOwner);
    return true;
  }, []);
  const release = useCallback((nextOwner: string) => {
    if (ownerRef.current !== nextOwner) return;
    ownerRef.current = null;
    setOwner(null);
  }, []);
  const value = useMemo(() => ({ owner, claim, release }), [claim, owner, release]);
  return (
    <SettingsMutationProvider value={value}>
      <button type="button" disabled={Boolean(owner)}>Leave Settings</button>
      {children}
    </SettingsMutationProvider>
  );
}

describe('BackupsTab mutation admission', () => {
  beforeEach(() => {
    mocks.get.mockReset().mockImplementation((url: string) => {
      if (url === '/backups/list') {
        return Promise.resolve({
          data: {
            backups: [backup],
            summary: {
              total: 1,
              totalSize: backup.size,
              totalSizeHuman: backup.sizeHuman,
              oldest: backup.created,
              newest: backup.created,
              complete: 1,
              degraded: 0,
              unknown: 0,
              newestComplete: backup.created,
            },
          },
        });
      }
      if (url === '/backups/cron-info') {
        return Promise.resolve({ data: { schedules: [], active: [], disabled: [] } });
      }
      if (url === '/backups/status') {
        return Promise.resolve({ data: { status: 'idle' } });
      }
      return Promise.reject(new Error(`Unexpected backup GET: ${url}`));
    });
    mocks.post.mockReset();
    mocks.delete.mockReset();
  });

  it('single-flights deletion, blocks dismissal, and keeps a retryable failure in the dialog', async () => {
    const user = userEvent.setup();
    const firstDelete = deferred<unknown>();
    mocks.delete.mockReturnValueOnce(firstDelete.promise);
    render(<BackupsTab />);

    await user.click(await screen.findByRole('button', { name: `Delete ${backup.filename}` }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete backup?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete backup' });
    act(() => {
      confirm.click();
      confirm.click();
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(mocks.delete).toHaveBeenCalledTimes(1);
    expect(mocks.delete).toHaveBeenCalledWith(`/backups/${encodeURIComponent(backup.filename)}`);
    expect(await within(dialog).findByRole('button', { name: 'Deleting backup…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('alertdialog', { name: 'Delete backup?' })).toBeVisible();

    await act(async () => {
      firstDelete.reject({ response: { data: { error: 'Backup is still in use' } } });
      await firstDelete.promise.catch(() => undefined);
    });

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Backup is still in use');
    expect(within(dialog).getByRole('button', { name: 'Delete backup' })).toBeEnabled();

    mocks.delete.mockResolvedValueOnce({ data: { ok: true } });
    await user.click(within(dialog).getByRole('button', { name: 'Delete backup' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'Delete backup?' })).not.toBeInTheDocument());
    expect(mocks.delete).toHaveBeenCalledTimes(2);
  });

  it('admits only one manual backup start in the same frame', async () => {
    const create = deferred<{ data: { status: string; error?: string } }>();
    mocks.post.mockReturnValueOnce(create.promise);
    render(
      <SettingsOwnershipHarness>
        <BackupsTab />
      </SettingsOwnershipHarness>,
    );

    const createButton = await screen.findByRole('button', { name: 'Create Backup Now' });
    act(() => {
      createButton.click();
      createButton.click();
    });

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith('/backups/create', { type: 'daily' });
    expect(await screen.findByRole('button', { name: 'Creating Backup...' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Leave Settings' })).toBeDisabled();

    await act(async () => {
      create.resolve({ data: { status: 'failed', error: 'Synthetic stop' } });
      await create.promise;
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create Backup Now' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Leave Settings' })).toBeEnabled();
  });

  it('releases Settings navigation after the background service accepts the backup', async () => {
    const create = deferred<{ data: { status: string; id: string } }>();
    mocks.post.mockReturnValueOnce(create.promise);
    const { unmount } = render(
      <SettingsOwnershipHarness>
        <BackupsTab />
      </SettingsOwnershipHarness>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Create Backup Now' }));
    expect(screen.getByRole('button', { name: 'Leave Settings' })).toBeDisabled();

    await act(async () => {
      create.resolve({ data: { status: 'queued', id: 'daily-background-job' } });
      await create.promise;
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Leave Settings' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Creating Backup...' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(/standard backups are authenticated online data snapshots/i)).toBeVisible();
    expect(mocks.get.mock.calls.some(([url]) => url === '/backups/status')).toBe(true);
    unmount();
  });

  it('reattaches to a running backup and presents its structured progress', async () => {
    mocks.get.mockImplementation((url: string) => {
      if (url === '/backups/list') {
        return Promise.resolve({
          data: {
            backups: [backup],
            summary: {
              total: 1,
              totalSize: backup.size,
              totalSizeHuman: backup.sizeHuman,
              oldest: backup.created,
              newest: backup.created,
            },
          },
        });
      }
      if (url === '/backups/cron-info') {
        return Promise.resolve({ data: { schedules: [], active: [], disabled: [] } });
      }
      if (url === '/backups/status') {
        return Promise.resolve({
          data: {
            id: 'comprehensive-existing-job',
            type: 'comprehensive',
            status: 'running',
            phase: 'database',
            phaseLabel: 'Backing up PostgreSQL',
            phaseIndex: 6,
            phaseTotal: 12,
          },
        });
      }
      return Promise.reject(new Error(`Unexpected backup GET: ${url}`));
    });
    const { unmount } = render(<BackupsTab />);

    expect(await screen.findByText('Phase 6 of 12')).toBeVisible();
    expect(screen.getByText('Backing up PostgreSQL')).toBeVisible();
    expect(screen.getByRole('progressbar', { name: 'Backup progress' })).toHaveAttribute('aria-valuenow', '6');
    expect(screen.getByRole('button', { name: 'Creating Backup...' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(/temporarily takes portal and agent services offline/i)).toBeVisible();
    expect(screen.getByText(/live progress pauses during that window/i)).toBeVisible();
    unmount();
  });

  it('shows the sanitized exact failure detail reported by the backup service', async () => {
    mocks.get.mockImplementation((url: string) => {
      if (url === '/backups/list') {
        return Promise.resolve({ data: { backups: [], summary: { total: 0, totalSize: 0, totalSizeHuman: '0 B', oldest: null, newest: null } } });
      }
      if (url === '/backups/cron-info') {
        return Promise.resolve({ data: { schedules: [], active: [], disabled: [] } });
      }
      if (url === '/backups/status') {
        return Promise.resolve({
          data: {
            id: 'failed-job',
            type: 'comprehensive',
            status: 'degraded',
            error: 'Backup process exited with code 1',
            failureDetail: 'Container database PGDATA is not on persistent writable storage',
          },
        });
      }
      return Promise.reject(new Error(`Unexpected backup GET: ${url}`));
    });
    render(<BackupsTab />);

    expect(await screen.findByText('Container database PGDATA is not on persistent writable storage')).toBeVisible();
    expect(screen.queryByText('Backup process exited with code 1')).not.toBeInTheDocument();
  });

  it('labels incomplete classifications and requires confirmation before degraded or unknown downloads', async () => {
    const user = userEvent.setup();
    const degraded = {
      ...backup,
      filename: 'portal-daily-degraded.tar.gz',
      completeness: 'degraded',
      degradedComponents: ['hosted-apps', 'projects'],
    };
    const unknown = {
      ...backup,
      filename: 'portal-daily-legacy.tar.gz',
      completeness: 'unknown',
      degradedComponents: [],
      classificationAuthenticated: false,
    };
    mocks.get.mockImplementation((url: string) => {
      if (url === '/backups/list') {
        return Promise.resolve({
          data: {
            backups: [degraded, unknown],
            summary: {
              total: 2,
              totalSize: 2048,
              totalSizeHuman: '2 KB',
              oldest: backup.created,
              newest: backup.created,
              complete: 0,
              degraded: 1,
              unknown: 1,
              newestComplete: null,
            },
          },
        });
      }
      if (url === '/backups/cron-info') return Promise.resolve({ data: { schedules: [], active: [], disabled: [] } });
      if (url === '/backups/status') return Promise.resolve({ data: { status: 'idle' } });
      if (url.startsWith('/backups/download-info/')) return Promise.resolve({ data: { ok: true } });
      return Promise.reject(new Error(`Unexpected backup GET: ${url}`));
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<BackupsTab />);

    expect(await screen.findByText('Salvage only')).toBeVisible();
    expect(screen.getByText('Unclassified')).toBeVisible();
    await user.click(screen.getByRole('button', { name: `Download ${degraded.filename}` }));
    const degradedDialog = screen.getByRole('alertdialog', { name: 'Download incomplete backup?' });
    expect(within(degradedDialog).getByText(/omitted required recovery components/i)).toBeVisible();
    expect(within(degradedDialog).getByText('Unavailable: hosted-apps, projects')).toBeVisible();
    expect(mocks.get.mock.calls.some(([url]) => String(url).startsWith('/backups/download-info/'))).toBe(false);
    await user.click(within(degradedDialog).getByRole('button', { name: 'Download anyway' }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(`/backups/download-info/${encodeURIComponent(degraded.filename)}`));

    await user.click(screen.getByRole('button', { name: `Download ${unknown.filename}` }));
    const unknownDialog = screen.getByRole('alertdialog', { name: 'Download unclassified backup?' });
    expect(within(unknownDialog).getByText(/cannot authenticate this legacy archive/i)).toBeVisible();
    await user.click(within(unknownDialog).getByRole('button', { name: 'Download anyway' }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(`/backups/download-info/${encodeURIComponent(unknown.filename)}`));
    expect(click).toHaveBeenCalledTimes(2);
    click.mockRestore();
  });

  it('surfaces repeated scheduled backup failures prominently', async () => {
    mocks.get.mockImplementation((url: string) => {
      if (url === '/backups/list') {
        return Promise.resolve({
          data: {
            backups: [],
            summary: {
              total: 0,
              totalSize: 0,
              totalSizeHuman: '0 B',
              oldest: null,
              newest: null,
              complete: 0,
              degraded: 0,
              unknown: 0,
              newestComplete: null,
            },
          },
        });
      }
      if (url === '/backups/cron-info') return Promise.resolve({ data: { schedules: [], active: [], disabled: [] } });
      if (url === '/backups/status') {
        return Promise.resolve({
          data: {
            status: 'degraded',
            consecutiveFailures: 3,
            failureDetail: 'Projects changed during capture',
          },
        });
      }
      return Promise.reject(new Error(`Unexpected backup GET: ${url}`));
    });
    render(<BackupsTab />);

    expect(await screen.findByText('Backups have been incomplete 3 times in a row')).toBeVisible();
    expect(screen.getByText('Projects changed during capture')).toBeVisible();
  });
});
