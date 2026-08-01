// @vitest-environment jsdom
import '../../test/setup';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EmailDetail from './EmailDetail';
import type { ComposeState } from './types';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiDownloadAttachment: vi.fn(),
}));

vi.mock('./api', () => ({
  apiFetch: mocks.apiFetch,
  apiDownloadAttachment: mocks.apiDownloadAttachment,
}));

vi.mock('../../utils/sounds', () => ({
  default: { click: vi.fn(), success: vi.fn(), error: vi.fn(), delete: vi.fn() },
}));

const email = {
  id: 'message-1',
  threadId: 'thread-1',
  mailboxIds: { inbox: true },
  from: [{ name: 'Sender', email: 'sender@example.com' }],
  to: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: 'Private newsletter',
  receivedAt: '2026-07-19T12:00:00.000Z',
  size: 1200,
  preview: 'Newsletter preview',
  hasAttachment: true,
  isUnread: false,
  isFlagged: false,
  htmlBody: [{ partId: 'html-1', type: 'text/html' }],
  textBody: [],
  bodyValues: {
    'html-1': { value: '<p>Hello</p><img src="https://tracker.example/pixel">', isEncodingProblem: false },
  },
  attachments: [{
    partId: 'attachment-1',
    blobId: 'blob-1',
    name: 'report.pdf',
    type: 'application/pdf',
    size: 400,
    isDangerous: false,
    downloadToken: 'signed-capability',
  }],
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

function renderDetail(message: any = email, onRefresh = vi.fn(), mailboxes: any[] = []) {
  mocks.apiFetch.mockImplementation(async (path: string) => {
    if (path === '/messages/message-1') return message;
    if (path === '/messages/message-1/read') return { success: true };
    if (path === '/attachments/blob-1/save-to-files') return { success: true };
    throw new Error(`Unexpected mail API path: ${path}`);
  });
  return {
    ...render(
      <EmailDetail
        emailId="message-1"
        onBack={vi.fn()}
        onRefresh={onRefresh}
        mailboxes={mailboxes}
        onCompose={vi.fn()}
        isMobile={false}
        account="mailbox-1"
      />,
    ),
    onRefresh,
  };
}

function renderOwnedDetail({
  apiImplementation,
  onBack = vi.fn(),
  onRefresh = vi.fn(),
  onCompose = vi.fn(),
  onMutationChange = vi.fn(),
  mailboxes = [],
}: {
  apiImplementation: (path: string, options?: unknown) => Promise<unknown>;
  onBack?: () => void;
  onRefresh?: () => boolean | void | Promise<boolean | void>;
  onCompose?: (state: ComposeState) => void;
  onMutationChange?: (activity: { kind: string; label: string; account?: string } | null) => void;
  mailboxes?: any[];
}) {
  mocks.apiFetch.mockImplementation(apiImplementation);
  render(
    <EmailDetail
      emailId="message-1"
      onBack={onBack}
      onRefresh={onRefresh}
      mailboxes={mailboxes}
      onCompose={onCompose}
      onMutationChange={onMutationChange}
      isMobile={false}
      account="mailbox-1"
    />,
  );
  return { onBack, onRefresh, onCompose, onMutationChange };
}

describe('EmailDetail attachment and remote-content boundaries', () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.apiDownloadAttachment.mockReset().mockResolvedValue(new Blob(['pdf'], { type: 'application/pdf' }));
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the server capability for download/save and blocks remote content until one-message opt-in', async () => {
    const user = userEvent.setup();
    renderDetail();

    expect(await screen.findByText('Private newsletter')).toBeVisible();
    expect(screen.getByText(/Remote images and styles are blocked/)).toBeVisible();
    const iframe = screen.getByTitle('Email content') as HTMLIFrameElement;
    await waitFor(() => expect(iframe.contentDocument?.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain('img-src data: blob: cid:'));

    await user.click(screen.getByRole('button', { name: 'Download report.pdf' }));
    expect(mocks.apiDownloadAttachment).toHaveBeenCalledWith('blob-1', 'signed-capability', 'mailbox-1');

    await user.click(screen.getByRole('button', { name: 'Save to Files' }));
    expect(mocks.apiFetch).toHaveBeenCalledWith('/attachments/blob-1/save-to-files', {
      method: 'POST',
      body: JSON.stringify({ token: 'signed-capability' }),
      account: 'mailbox-1',
    });

    await user.click(screen.getByRole('button', { name: 'Load once' }));
    await waitFor(() => expect(iframe.contentDocument?.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain('img-src http: https:'));
    expect(screen.getByRole('button', { name: 'Block again' })).toBeVisible();
  });

  it('fails closed when a non-dangerous attachment has no verified capability', async () => {
    renderDetail({
      ...email,
      attachments: [{ ...email.attachments[0], downloadToken: null }],
    });

    const download = await screen.findByRole('button', { name: 'Download report.pdf' });
    expect(download).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save to Files' })).not.toBeInTheDocument();
    fireEvent.click(download);
    expect(mocks.apiDownloadAttachment).not.toHaveBeenCalled();
  });

  it('uses the explicit read mutation and refreshes the list for an unread message', async () => {
    const { onRefresh } = renderDetail({ ...email, isUnread: true });

    expect(await screen.findByText('Private newsletter')).toBeVisible();
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledWith('/messages/message-1/read', {
      method: 'POST',
      body: JSON.stringify({ read: true }),
      account: 'mailbox-1',
    }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('uses the shared anchored move menu and restores its toolbar trigger', async () => {
    const user = userEvent.setup();
    renderDetail(email, vi.fn(), [{
      id: 'archive',
      name: 'Archive',
      role: 'archive',
      totalEmails: 2,
      unreadEmails: 0,
    }]);

    const trigger = await screen.findByRole('button', { name: 'Move message to folder' });
    await user.click(trigger);
    const menu = await screen.findByRole('menu', { name: 'Move message to folder' });
    expect(menu.closest('[data-anchored-popover-root="true"]')?.parentElement).toBe(document.body);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(menu).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('ignores a stale message response after switching messages', async () => {
    let resolveFirst: ((value: typeof email) => void) | undefined;
    const first = new Promise<typeof email>((resolve) => { resolveFirst = resolve; });
    const second = { ...email, id: 'message-2', subject: 'Current message' };
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/messages/message-1') return first;
      if (path === '/messages/message-2') return second;
      throw new Error(`Unexpected mail API path: ${path}`);
    });

    const view = render(
      <EmailDetail
        emailId="message-1"
        onBack={vi.fn()}
        onRefresh={vi.fn()}
        mailboxes={[]}
        onCompose={vi.fn()}
        isMobile={false}
        account="mailbox-1"
      />,
    );
    view.rerender(
      <EmailDetail
        emailId="message-2"
        onBack={vi.fn()}
        onRefresh={vi.fn()}
        mailboxes={[]}
        onCompose={vi.fn()}
        isMobile={false}
        account="mailbox-1"
      />,
    );

    expect(await screen.findByText('Current message')).toBeVisible();
    resolveFirst?.(email);
    await Promise.resolve();
    expect(screen.queryByText('Private newsletter')).not.toBeInTheDocument();
  });

  it('single-flights flag and trash mutations while blocking conflicting navigation', async () => {
    const flagPending = deferred<unknown>();
    const trashPending = deferred<unknown>();
    mocks.apiFetch.mockImplementation((path: string) => {
      if (path === '/messages/message-1') return Promise.resolve(email);
      if (path === '/messages/message-1/flag') return flagPending.promise;
      if (path === '/messages/message-1/trash') return trashPending.promise;
      return Promise.resolve({ success: true });
    });
    const onBack = vi.fn();
    const onCompose = vi.fn();
    const onMutationChange = vi.fn();
    render(
      <EmailDetail
        emailId="message-1"
        onBack={onBack}
        onRefresh={vi.fn()}
        mailboxes={[]}
        onCompose={onCompose}
        isMobile={false}
        onMutationChange={onMutationChange}
        account="mailbox-1"
      />,
    );
    expect(await screen.findByText('Private newsletter')).toBeVisible();

    const flag = screen.getByRole('button', { name: 'Flag message' });
    act(() => {
      flag.click();
      flag.click();
      screen.getByRole('button', { name: 'Move message to trash' }).click();
      screen.getByRole('button', { name: 'Mark as unread' }).click();
      screen.getByRole('button', { name: 'Back to message list' }).click();
      screen.getByRole('button', { name: 'Reply' }).click();
    });

    expect(mocks.apiFetch.mock.calls.filter(([path]) => path !== '/messages/message-1')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Updating message flag…' })).toHaveAttribute('aria-busy', 'true');
    expect(document.querySelectorAll('[aria-busy="true"]')).toHaveLength(1);
    expect(onMutationChange).toHaveBeenNthCalledWith(1, {
      kind: 'flag',
      label: 'Flagging message',
      account: 'mailbox-1',
    });
    expect(Object.isFrozen(onMutationChange.mock.calls[0][0])).toBe(true);
    expect(onBack).not.toHaveBeenCalled();
    expect(onCompose).not.toHaveBeenCalled();

    await act(async () => {
      flagPending.resolve({ success: true });
      await flagPending.promise;
    });
    expect(onMutationChange).toHaveBeenLastCalledWith(null);

    const trash = screen.getByRole('button', { name: 'Move message to trash' });
    act(() => {
      trash.click();
      trash.click();
      screen.getByRole('button', { name: 'Remove flag' }).click();
    });
    expect(mocks.apiFetch.mock.calls.filter(([path]) => path === '/messages/message-1/trash')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Moving message to Trash…' })).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      trashPending.resolve({ success: true });
      await trashPending.promise;
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed read snapshot locally visible and retryable', async () => {
    const readPending = deferred<unknown>();
    let readAttempts = 0;
    const onRefresh = vi.fn();
    renderOwnedDetail({
      onRefresh,
      apiImplementation: (path) => {
        if (path === '/messages/message-1') return Promise.resolve(email);
        if (path === '/messages/message-1/read') {
          readAttempts += 1;
          return readAttempts === 1 ? readPending.promise : Promise.resolve({ success: true });
        }
        return Promise.resolve({ success: true });
      },
    });
    expect(await screen.findByText('Private newsletter')).toBeVisible();
    const read = screen.getByRole('button', { name: 'Mark as unread' });

    act(() => {
      read.click();
      read.click();
    });
    expect(readAttempts).toBe(1);
    expect(screen.getByRole('button', { name: 'Updating message read status…' })).toBeDisabled();

    await act(async () => {
      readPending.reject(new Error('Read status is temporarily locked'));
      await readPending.promise.catch(() => undefined);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Read status is temporarily locked');
    expect(screen.getByRole('button', { name: 'Mark as unread' })).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: 'Mark as unread' }));
    await waitFor(() => expect(readAttempts).toBe(2));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('keeps detail ownership active until the mailbox readback resolves', async () => {
    const refresh = deferred<boolean>();
    const onRefresh = vi.fn().mockReturnValue(refresh.promise);
    const onMutationChange = vi.fn();
    renderOwnedDetail({
      onRefresh,
      onMutationChange,
      apiImplementation: (path) => {
        if (path === '/messages/message-1') return Promise.resolve(email);
        if (path === '/messages/message-1/read') return Promise.resolve({ success: true });
        return Promise.resolve({ success: true });
      },
    });

    expect(await screen.findByText('Private newsletter')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Mark as unread' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Updating message read status…' })).toHaveAttribute('aria-busy', 'true');
    expect(onMutationChange).not.toHaveBeenLastCalledWith(null);

    await act(async () => {
      refresh.resolve(true);
      await refresh.promise;
    });
    expect(onMutationChange).toHaveBeenLastCalledWith(null);
  });

  it('keeps accepted trash visible until authoritative refresh and retries verification without resubmitting', async () => {
    const firstRefresh = deferred<boolean>();
    const onRefresh = vi.fn()
      .mockReturnValueOnce(firstRefresh.promise)
      .mockResolvedValueOnce(true);
    const onBack = vi.fn();
    const onMutationChange = vi.fn();
    let trashAttempts = 0;
    renderOwnedDetail({
      onBack,
      onRefresh,
      onMutationChange,
      apiImplementation: (path) => {
        if (path === '/messages/message-1') return Promise.resolve(email);
        if (path === '/messages/message-1/trash') {
          trashAttempts += 1;
          return Promise.resolve({ success: true });
        }
        return Promise.resolve({ success: true });
      },
    });

    expect(await screen.findByText('Private newsletter')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Move message to trash' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(onBack).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Moving message to Trash…' })).toHaveAttribute('aria-busy', 'true');
    expect(onMutationChange).not.toHaveBeenLastCalledWith(null);

    await act(async () => {
      firstRefresh.resolve(false);
      await firstRefresh.promise;
    });

    expect(onBack).not.toHaveBeenCalled();
    expect(trashAttempts).toBe(1);
    expect(await screen.findByRole('alert')).toHaveTextContent(/moved to Trash.*could not verify/i);
    expect(screen.getByRole('button', { name: 'Back to message list' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Retry mailbox refresh' }));
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(trashAttempts).toBe(1);
  });

  it('retains an accepted move after readback failure and retries only the mailbox refresh', async () => {
    const onRefresh = vi.fn()
      .mockRejectedValueOnce(new Error('Mailbox refresh failed after move'))
      .mockResolvedValueOnce(true);
    const onBack = vi.fn();
    let moveAttempts = 0;
    renderOwnedDetail({
      onBack,
      onRefresh,
      mailboxes: [{ id: 'archive', name: 'Archive', role: 'archive', totalEmails: 1, unreadEmails: 0 }],
      apiImplementation: (path) => {
        if (path === '/messages/message-1') return Promise.resolve(email);
        if (path === '/messages/message-1/move') {
          moveAttempts += 1;
          return Promise.resolve({ success: true });
        }
        return Promise.resolve({ success: true });
      },
    });

    const user = userEvent.setup();
    expect(await screen.findByText('Private newsletter')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Move message to folder' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Mailbox refresh failed after move');
    expect(onBack).not.toHaveBeenCalled();
    expect(moveAttempts).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Retry mailbox refresh' }));
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(moveAttempts).toBe(1);
  });

  it('owns move progress in the portaled menu and retries a failed immutable destination', async () => {
    const movePending = deferred<unknown>();
    let moveAttempts = 0;
    const onBack = vi.fn();
    renderOwnedDetail({
      onBack,
      mailboxes: [{ id: 'archive', name: 'Archive', role: 'archive', totalEmails: 1, unreadEmails: 0 }],
      apiImplementation: (path) => {
        if (path === '/messages/message-1') return Promise.resolve(email);
        if (path === '/messages/message-1/move') {
          moveAttempts += 1;
          return moveAttempts === 1 ? movePending.promise : Promise.resolve({ success: true });
        }
        return Promise.resolve({ success: true });
      },
    });
    const user = userEvent.setup();
    expect(await screen.findByText('Private newsletter')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Move message to folder' }));
    const archive = await screen.findByRole('menuitem', { name: 'Archive' });

    act(() => {
      archive.click();
      archive.click();
      screen.getByRole('button', { name: 'Move message to trash' }).click();
      screen.getByRole('button', { name: 'Back to message list' }).click();
    });
    expect(moveAttempts).toBe(1);
    expect(screen.getByRole('menuitem', { name: 'Moving…' })).toHaveAttribute('aria-busy', 'true');
    expect(onBack).not.toHaveBeenCalled();

    await act(async () => {
      movePending.reject(new Error('Archive rejected this message'));
      await movePending.promise.catch(() => undefined);
    });
    expect((await screen.findAllByText('Archive rejected this message')).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(moveAttempts).toBe(2));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('single-flights download and save-to-files across every attachment action', async () => {
    const downloadPending = deferred<Blob>();
    const savePending = deferred<unknown>();
    let saveAttempts = 0;
    mocks.apiDownloadAttachment.mockReturnValue(downloadPending.promise);
    const onBack = vi.fn();
    renderOwnedDetail({
      onBack,
      apiImplementation: (path) => {
        if (path === '/messages/message-1') return Promise.resolve(email);
        if (path === '/attachments/blob-1/save-to-files') {
          saveAttempts += 1;
          return saveAttempts === 1 ? savePending.promise : Promise.resolve({ success: true });
        }
        return Promise.resolve({ success: true });
      },
    });
    expect(await screen.findByText('Private newsletter')).toBeVisible();
    const download = screen.getByRole('button', { name: 'Download report.pdf' });

    act(() => {
      download.click();
      download.click();
      screen.getByRole('button', { name: 'Save to Files' }).click();
      screen.getByRole('button', { name: 'Back to message list' }).click();
    });
    expect(mocks.apiDownloadAttachment).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Downloading report.pdf…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Save to Files' })).toBeDisabled();
    expect(onBack).not.toHaveBeenCalled();

    await act(async () => {
      downloadPending.resolve(new Blob(['pdf'], { type: 'application/pdf' }));
      await downloadPending.promise;
    });

    const save = screen.getByRole('button', { name: 'Save to Files' });
    act(() => {
      save.click();
      save.click();
      screen.getByRole('button', { name: 'Download report.pdf' }).click();
    });
    expect(saveAttempts).toBe(1);
    expect(screen.getByRole('button', { name: 'Saving report.pdf to Files…' })).toHaveAttribute('aria-busy', 'true');
    expect(mocks.apiDownloadAttachment).toHaveBeenCalledTimes(1);

    await act(async () => {
      savePending.reject(new Error('Files is temporarily unavailable'));
      await savePending.promise.catch(() => undefined);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Files is temporarily unavailable');
    expect(screen.getByRole('button', { name: 'Save to Files' })).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: 'Save to Files' }));
    await waitFor(() => expect(saveAttempts).toBe(2));
  });
});
