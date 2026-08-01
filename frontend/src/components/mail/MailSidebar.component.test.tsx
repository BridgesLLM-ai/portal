// @vitest-environment jsdom
import '../../test/setup';
import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import MailSidebar from './MailSidebar';

function MobileSidebarHarness({
  onCompose = vi.fn(),
  onSelectMailbox = vi.fn(),
  interactionBlocked = false,
}: {
  onCompose?: () => void;
  onSelectMailbox?: (role: string) => void;
  interactionBlocked?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open mailbox navigation</button>
      <MailSidebar
        mailboxes={[{ id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 3, unreadEmails: 1 }]}
        activeMailbox="inbox"
        onSelectMailbox={onSelectMailbox}
        onCompose={onCompose}
        isOpen={open}
        onClose={() => setOpen(false)}
        isMobile
        interactionBlocked={interactionBlocked}
      />
    </>
  );
}

describe('MailSidebar mobile interaction ownership', () => {
  it('uses the viewport modal foundation, traps focus, and restores the opener after Escape', async () => {
    const user = userEvent.setup();
    const { container } = render(<MobileSidebarHarness />);
    const opener = screen.getByRole('button', { name: 'Open mailbox navigation' });

    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Mailbox navigation' });
    const close = screen.getByRole('button', { name: 'Close mailbox navigation' });

    expect(dialog.closest('[data-viewport-overlay-root="true"]')?.parentElement).toBe(document.body);
    expect(container).toHaveAttribute('inert');
    expect(document.body).toHaveStyle({ overflow: 'hidden' });
    await waitFor(() => expect(close).toHaveFocus());

    await user.keyboard('{Escape}');
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
    expect(container).not.toHaveAttribute('inert');
    expect(document.body).not.toHaveStyle({ overflow: 'hidden' });
  });

  it('closes the drawer exactly once when Compose hands ownership to its parent', async () => {
    const user = userEvent.setup();
    const onCompose = vi.fn();
    render(<MobileSidebarHarness onCompose={onCompose} />);

    await user.click(screen.getByRole('button', { name: 'Open mailbox navigation' }));
    await user.click(await screen.findByRole('button', { name: 'Compose' }));

    expect(onCompose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Mailbox navigation' })).not.toBeInTheDocument());
  });

  it('keeps mobile navigation modal and every sibling action inert while a child mutation owns Mail', async () => {
    const user = userEvent.setup();
    const onCompose = vi.fn();
    const onSelectMailbox = vi.fn();
    render(
      <MobileSidebarHarness
        interactionBlocked
        onCompose={onCompose}
        onSelectMailbox={onSelectMailbox}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Open mailbox navigation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mailbox navigation' });
    const close = screen.getByRole('button', { name: 'Close mailbox navigation' });
    const compose = screen.getByRole('button', { name: 'Compose' });
    const inbox = screen.getByRole('button', { name: /Inbox/ });
    expect(close).toBeDisabled();
    expect(compose).toBeDisabled();
    expect(inbox).toBeDisabled();

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(close);
    fireEvent.click(compose);
    fireEvent.click(inbox);

    expect(dialog).toBeVisible();
    expect(onCompose).not.toHaveBeenCalled();
    expect(onSelectMailbox).not.toHaveBeenCalled();
  });
});
