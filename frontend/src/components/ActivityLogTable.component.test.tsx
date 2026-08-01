// @vitest-environment jsdom
import '../test/setup';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ActivityLogTable from './ActivityLogTable';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  unblockIP: vi.fn(),
  archive: vi.fn(),
}));

vi.mock('../api/endpoints', () => ({
  activityAPI: {
    list: mocks.list,
    unblockIP: mocks.unblockIP,
    archive: mocks.archive,
  },
}));

const blockedLogs = [
  {
    id: 'block-a',
    action: 'IP_BLOCKED',
    resource: 'security',
    translatedMessage: 'Blocked suspicious request',
    severity: 'WARNING' as const,
    createdAt: '2026-07-21T12:00:00.000Z',
    ipAddress: '203.0.113.10',
    metadata: { ip: '203.0.113.10', reason: 'bot_trap' },
  },
  {
    id: 'block-b',
    action: 'IP_BLOCKED',
    resource: 'security',
    translatedMessage: 'Blocked repeated request',
    severity: 'WARNING' as const,
    createdAt: '2026-07-21T12:01:00.000Z',
    ipAddress: '203.0.113.11',
    metadata: { ip: '203.0.113.11', reason: 'rate_limit' },
  },
];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('ActivityLogTable mutation ownership', () => {
  beforeEach(() => {
    mocks.list.mockReset().mockResolvedValue({
      logs: blockedLogs,
      total: blockedLogs.length,
      pages: 1,
      page: 1,
    });
    mocks.unblockIP.mockReset();
    mocks.archive.mockReset();
  });

  it('single-flights unblocking and prevents a same-frame cross-row/archive race', async () => {
    const request = deferred<unknown>();
    mocks.unblockIP.mockReturnValueOnce(request.promise);
    render(<ActivityLogTable standalone />);

    const first = await screen.findByRole('button', { name: 'Unblock 203.0.113.10' });
    const second = screen.getByRole('button', { name: 'Unblock 203.0.113.11' });
    const archive = screen.getByRole('button', { name: 'Archive old activity entries' });
    act(() => {
      first.click();
      first.click();
      second.click();
      archive.click();
    });

    expect(mocks.unblockIP).toHaveBeenCalledTimes(1);
    expect(mocks.unblockIP).toHaveBeenCalledWith('203.0.113.10', 'block-a');
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog', { name: 'Archive old activity?' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Unblocking…' })).toHaveAttribute('aria-busy', 'true');
    expect(second).toBeDisabled();
    expect(archive).toBeDisabled();

    await act(async () => {
      request.resolve({ ok: true });
      await request.promise;
    });
    await waitFor(() => expect(first).toBeEnabled());
    expect(second).toBeEnabled();
    expect(archive).toBeEnabled();
  });

  it('keeps archive progress and retryable errors in one modal-owned action', async () => {
    const user = userEvent.setup();
    const request = deferred<{ archived: number }>();
    mocks.archive.mockReturnValueOnce(request.promise);
    render(<ActivityLogTable standalone />);

    await user.click(await screen.findByRole('button', { name: 'Archive old activity entries' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Archive old activity?' });
    const confirm = within(dialog).getByRole('button', { name: 'Archive old entries' });
    const unblock = screen.getByRole('button', { name: 'Unblock 203.0.113.10', hidden: true });
    act(() => {
      confirm.click();
      confirm.click();
      unblock.click();
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(mocks.archive).toHaveBeenCalledTimes(1);
    expect(mocks.unblockIP).not.toHaveBeenCalled();
    expect(await within(dialog).findByRole('button', { name: 'Archiving…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('alertdialog', { name: 'Archive old activity?' })).toBeVisible();

    await act(async () => {
      request.reject({ response: { data: { error: 'Archive store is locked' } } });
      await request.promise.catch(() => undefined);
    });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Archive store is locked');
    expect(within(dialog).getByRole('button', { name: 'Archive old entries' })).toBeEnabled();

    mocks.archive.mockResolvedValueOnce({ archived: 3 });
    await user.click(within(dialog).getByRole('button', { name: 'Archive old entries' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'Archive old activity?' })).not.toBeInTheDocument());
    expect(mocks.archive).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Archived 3 activities')).toBeInTheDocument();
  });
});
