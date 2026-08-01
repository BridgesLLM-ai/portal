// @vitest-environment jsdom
import '../../test/setup';
import { useId, useRef, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EmailList from './EmailList';
import { MoveToDropdown } from './MoveToDropdown';
import type { MailboxInfo } from './types';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock('./api', () => ({
  apiFetch: mocks.apiFetch,
}));

vi.mock('../../utils/sounds', () => ({
  default: { click: vi.fn(), success: vi.fn(), error: vi.fn(), delete: vi.fn() },
}));

const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;

const mailboxes: MailboxInfo[] = [
  { id: 'archive', name: 'Archive', role: 'archive', totalEmails: 10, unreadEmails: 0 },
  { id: 'projects', name: 'Projects', role: null, totalEmails: 4, unreadEmails: 1 },
  { id: 'trash', name: 'Trash', role: 'trash', totalEmails: 2, unreadEmails: 0 },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
});

function Harness({ onMove = vi.fn() }: { onMove?: (mailboxId: string) => void }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  return (
    <div data-testid="clipped-mail-toolbar" style={{ overflow: 'hidden', width: 180 }}>
      <button
        ref={anchorRef}
        type="button"
        aria-label="Move message to folder"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        Move
      </button>
      <button type="button">Behind menu</button>
      <MoveToDropdown
        open={open}
        anchorRef={anchorRef}
        menuId={menuId}
        mailboxes={mailboxes}
        onMove={onMove}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

describe('MoveToDropdown', () => {
  it('portals beyond clipped mail chrome and supports roving arrow-key selection', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    const { container } = render(<Harness onMove={onMove} />);
    const trigger = screen.getByRole('button', { name: 'Move message to folder' });

    await user.click(trigger);
    const menu = await screen.findByRole('menu', { name: 'Move message to folder' });
    const archive = screen.getByRole('menuitem', { name: 'Archive' });
    const projects = screen.getByRole('menuitem', { name: 'Projects' });
    const trash = screen.getByRole('menuitem', { name: 'Trash' });
    await waitFor(() => expect(archive).toHaveFocus());
    expect(container.contains(menu)).toBe(false);
    expect(menu.closest('[data-anchored-popover-root="true"]')?.parentElement).toBe(document.body);

    await user.keyboard('{ArrowDown}');
    expect(projects).toHaveFocus();
    await user.keyboard('{End}');
    expect(trash).toHaveFocus();
    await user.keyboard('{Home}');
    expect(archive).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(trash).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(onMove).toHaveBeenCalledWith('trash');
    await waitFor(() => expect(menu).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('dismisses with Escape through the shared layer and restores the trigger', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Move message to folder' });
    await user.click(trigger);
    expect(await screen.findByRole('menu', { name: 'Move message to folder' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Move message to folder' })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('becomes a focus-owned, scroll-locked sheet on narrow screens', async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 667 });
    const { container } = render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Move message to folder' });

    await user.click(trigger);
    const menu = await screen.findByRole('menu', { name: 'Move message to folder' });
    expect(menu.closest('[data-anchored-popover-mode="sheet"]')).not.toBeNull();
    expect(container).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Archive' })).toHaveFocus());

    await user.click(screen.getByRole('menuitem', { name: 'Cancel' }));
    await waitFor(() => expect(menu).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(document.body.style.overflow).toBe('');
  });

  it('single-flights the async move and refuses Escape or Cancel until it settles', async () => {
    const user = userEvent.setup();
    const move = deferred<void>();
    const onMove = vi.fn(() => move.promise);
    render(<Harness onMove={onMove} />);
    const trigger = screen.getByRole('button', { name: 'Move message to folder' });
    await user.click(trigger);
    const archive = await screen.findByRole('menuitem', { name: 'Archive' });

    await waitFor(() => expect(archive).toHaveFocus());
    fireEvent.click(archive);
    fireEvent.click(archive);
    const moving = screen.getByRole('menuitem', { name: 'Moving…' });
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(moving).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('menuitem', { name: 'Cancel' })).toBeDisabled();

    await user.keyboard('{Escape}');
    expect(screen.getByRole('menu', { name: 'Move message to folder' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Behind menu' }));
    expect(screen.getByRole('menu', { name: 'Move message to folder' })).toBeInTheDocument();

    move.resolve();
    await move.promise;
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Move message to folder' })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('keeps a failed move visible and retryable inside the owning menu', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn().mockRejectedValue(new Error('Mailbox move was rejected safely'));
    render(<Harness onMove={onMove} />);
    await user.click(screen.getByRole('button', { name: 'Move message to folder' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Mailbox move was rejected safely');
    expect(screen.getByRole('menu', { name: 'Move message to folder' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Archive' })).toHaveFocus());
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeEnabled();

    await user.click(screen.getByRole('menuitem', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Move message to folder' })).not.toBeInTheDocument());
  });

  it('keeps the EmailList bulk-move usage portaled and sends the selected snapshot', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    mocks.apiFetch.mockResolvedValue({ success: true });
    const { container } = render(
      <EmailList
        emails={[{
          id: 'message-1',
          threadId: 'thread-1',
          mailboxIds: { inbox: true },
          from: [{ name: 'Sender', email: 'sender@example.com' }],
          to: [{ name: 'Owner', email: 'owner@example.com' }],
          subject: 'Portal status',
          receivedAt: '2026-07-21T12:00:00.000Z',
          size: 1200,
          preview: 'Status report',
          hasAttachment: false,
          isUnread: true,
          isFlagged: false,
        }]}
        total={1}
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
        onSelectEmail={vi.fn()}
        onRefresh={onRefresh}
        onSearchChange={vi.fn()}
        onPageChange={vi.fn()}
        onOpenSidebar={vi.fn()}
        onLoadMailboxes={vi.fn()}
        account="mailbox-1"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Select email Portal status' }));
    await user.click(screen.getByRole('button', { name: 'Move selected messages to folder' }));
    const menu = await screen.findByRole('menu', { name: 'Move message to folder' });
    expect(container.contains(menu)).toBe(false);
    await user.click(screen.getByRole('menuitem', { name: 'Projects' }));

    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledWith('/bulk/move', {
      method: 'POST',
      body: JSON.stringify({ emailIds: ['message-1'], targetMailboxId: 'projects' }),
      account: 'mailbox-1',
    }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(menu).not.toBeInTheDocument();
  });
});
