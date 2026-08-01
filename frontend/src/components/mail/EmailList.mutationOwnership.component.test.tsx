// @vitest-environment jsdom
import '../../test/setup';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EmailList from './EmailList';
import type { EmailSummary, MailboxInfo } from './types';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('./api', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('../../utils/sounds', () => ({
  default: { click: vi.fn(), success: vi.fn(), error: vi.fn(), delete: vi.fn() },
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const emails: EmailSummary[] = [
  {
    id: 'message-1',
    threadId: 'thread-1',
    mailboxIds: { inbox: true },
    from: [{ name: 'First Sender', email: 'first@example.com' }],
    to: [{ name: 'Owner', email: 'owner@example.com' }],
    subject: 'First message',
    receivedAt: '2026-07-21T12:00:00.000Z',
    size: 1200,
    preview: 'First preview',
    hasAttachment: false,
    isUnread: true,
    isFlagged: false,
  },
  {
    id: 'message-2',
    threadId: 'thread-2',
    mailboxIds: { inbox: true },
    from: [{ name: 'Second Sender', email: 'second@example.com' }],
    to: [{ name: 'Owner', email: 'owner@example.com' }],
    subject: 'Second message',
    receivedAt: '2026-07-21T13:00:00.000Z',
    size: 900,
    preview: 'Second preview',
    hasAttachment: false,
    isUnread: false,
    isFlagged: false,
  },
];

const mailboxes: MailboxInfo[] = [
  { id: 'archive', name: 'Archive', role: 'archive', totalEmails: 2, unreadEmails: 0 },
];

function renderList() {
  const callbacks = {
    onSelectEmail: vi.fn(),
    onRefresh: vi.fn(),
    onSearchChange: vi.fn(),
    onPageChange: vi.fn(),
    onOpenSidebar: vi.fn(),
    onLoadMailboxes: vi.fn(),
    onMutationChange: vi.fn(),
  };
  render(
    <EmailList
      emails={emails}
      total={30}
      page={0}
      pageSize={25}
      loading={false}
      refreshing={false}
      error=""
      searchQuery=""
      activeMailbox="inbox"
      inboxUnread={1}
      mailboxes={mailboxes}
      isMobile={false}
      {...callbacks}
      account="mailbox-1"
    />,
  );
  return callbacks;
}

describe('EmailList mutation ownership', () => {
  beforeEach(() => mocks.apiFetch.mockReset());

  it('single-flights a bulk snapshot and blocks cross-actions, selection, and navigation', async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    mocks.apiFetch.mockReturnValue(pending.promise);
    const callbacks = renderList();

    await user.click(screen.getByRole('button', { name: 'Select email First message' }));
    const markRead = screen.getByRole('button', { name: 'Mark selected messages as read' });
    const trash = screen.getByRole('button', { name: 'Move selected messages to Trash' });
    const secondSelection = screen.getByRole('button', { name: 'Select email Second message' });
    const secondRow = screen.getByRole('button', { name: 'Open email Second message' });
    const nextPage = screen.getByRole('button', { name: 'Next email page' });

    act(() => {
      markRead.click();
      markRead.click();
      trash.click();
      secondSelection.click();
      secondRow.click();
      nextPage.click();
    });

    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetch).toHaveBeenCalledWith('/bulk/read', {
      method: 'POST',
      body: JSON.stringify({ emailIds: ['message-1'], read: true }),
      account: 'mailbox-1',
    });
    expect(callbacks.onMutationChange).toHaveBeenNthCalledWith(1, {
      kind: 'bulk-read',
      label: 'Marking selected messages as read',
      account: 'mailbox-1',
    });
    expect(Object.isFrozen(callbacks.onMutationChange.mock.calls[0][0])).toBe(true);
    expect(screen.getByRole('button', { name: 'Marking selected messages as read…' })).toHaveAttribute('aria-busy', 'true');
    expect(document.querySelectorAll('[aria-busy="true"]')).toHaveLength(1);
    expect(trash).toBeDisabled();
    expect(secondSelection).toBeDisabled();
    expect(secondRow).toHaveAttribute('aria-disabled', 'true');
    expect(callbacks.onSelectEmail).not.toHaveBeenCalled();
    expect(callbacks.onPageChange).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({ success: true });
      await pending.promise;
    });
    expect(callbacks.onRefresh).toHaveBeenCalledTimes(1);
    expect(callbacks.onMutationChange).toHaveBeenLastCalledWith(null);
  });

  it('owns a bulk move across the portaled menu and keeps a failed snapshot retryable', async () => {
    const user = userEvent.setup();
    const firstMove = deferred<unknown>();
    mocks.apiFetch
      .mockReturnValueOnce(firstMove.promise)
      .mockResolvedValueOnce({ success: true });
    const callbacks = renderList();

    await user.click(screen.getByRole('button', { name: 'Select email First message' }));
    await user.click(screen.getByRole('button', { name: 'Move selected messages to folder' }));
    const archive = await screen.findByRole('menuitem', { name: 'Archive' });

    act(() => {
      archive.click();
      archive.click();
      screen.getByRole('button', { name: 'Move selected messages to Trash' }).click();
      screen.getByRole('button', { name: 'Open email Second message' }).click();
    });

    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetch).toHaveBeenCalledWith('/bulk/move', {
      method: 'POST',
      body: JSON.stringify({ emailIds: ['message-1'], targetMailboxId: 'archive' }),
      account: 'mailbox-1',
    });
    expect(screen.getByRole('menuitem', { name: 'Moving…' })).toHaveAttribute('aria-busy', 'true');
    expect(callbacks.onSelectEmail).not.toHaveBeenCalled();

    await act(async () => {
      firstMove.reject(new Error('Archive is temporarily unavailable'));
      await firstMove.promise.catch(() => undefined);
    });
    expect((await screen.findAllByText('Archive is temporarily unavailable')).length).toBeGreaterThan(0);
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeEnabled();

    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2));
    expect(callbacks.onRefresh).toHaveBeenCalledTimes(1);
  });

  it('single-flights a row read mutation and leaves local failure retryable', async () => {
    const pending = deferred<unknown>();
    mocks.apiFetch
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ success: true });
    const callbacks = renderList();
    const read = screen.getByRole('button', { name: 'Mark message as read' });

    act(() => {
      fireEvent.click(read);
      fireEvent.click(read);
      screen.getByRole('button', { name: 'Open email Second message' }).click();
    });
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Updating message read status…' })).toHaveAttribute('aria-busy', 'true');
    expect(callbacks.onSelectEmail).not.toHaveBeenCalled();

    await act(async () => {
      pending.reject(new Error('Read status is temporarily locked'));
      await pending.promise.catch(() => undefined);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Read status is temporarily locked');
    expect(callbacks.onMutationChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole('button', { name: 'Mark message as read' })).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: 'Mark message as read' }));
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2));
  });

  it('retains the page mutation lease until mailbox readback settles', async () => {
    const refresh = deferred<boolean>();
    mocks.apiFetch.mockResolvedValue({ success: true });
    const callbacks = renderList();
    callbacks.onRefresh.mockReturnValue(refresh.promise);

    await userEvent.click(screen.getByRole('button', { name: 'Select email First message' }));
    act(() => {
      screen.getByRole('button', { name: 'Mark selected messages as read' }).click();
    });

    await waitFor(() => expect(callbacks.onRefresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Marking selected messages as read…' })).toHaveAttribute('aria-busy', 'true');
    screen.getByRole('button', { name: 'Open email Second message' }).click();
    expect(callbacks.onSelectEmail).not.toHaveBeenCalled();
    expect(callbacks.onMutationChange).not.toHaveBeenLastCalledWith(null);

    await act(async () => {
      refresh.resolve(true);
      await refresh.promise;
    });
    expect(callbacks.onMutationChange).toHaveBeenLastCalledWith(null);
  });
});
