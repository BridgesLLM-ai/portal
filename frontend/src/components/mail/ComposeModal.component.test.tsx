// @vitest-environment jsdom
import '../../test/setup';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ComposeModal from './ComposeModal';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiSendWithAttachments: vi.fn(),
}));

vi.mock('./api', () => ({
  apiFetch: mocks.apiFetch,
  apiSendWithAttachments: mocks.apiSendWithAttachments,
}));

vi.mock('../../utils/sounds', () => ({
  default: { upload: vi.fn(), error: vi.fn() },
}));

const baseProps = {
  onClose: vi.fn(),
  onSent: vi.fn(),
  composeState: { mode: 'new' as const },
  mailboxes: [],
  isMobile: false,
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

function mockPendingSend() {
  const pending = deferred<unknown>();
  mocks.apiFetch.mockImplementation((path: string) => {
    if (path === '/signature') return Promise.resolve({ signature: '', signatureHtml: '' });
    if (path === '/send') return pending.promise;
    return Promise.resolve({});
  });
  return pending;
}

function fillValidMessage() {
  fireEvent.change(screen.getByLabelText('To'), { target: { value: 'recipient@example.com' } });
  fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Status update' } });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'The message body' } });
}

beforeEach(() => {
  Object.defineProperty(window, 'scrollTo', { configurable: true, value: vi.fn() });
});

describe('ComposeModal signature isolation', () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.apiSendWithAttachments.mockReset();
    baseProps.onClose.mockReset();
    baseProps.onSent.mockReset();
  });

  it('clears the prior account signature before resolving the next account', async () => {
    mocks.apiFetch
      .mockResolvedValueOnce({ signature: 'Alice signature', signatureHtml: '' })
      .mockImplementationOnce(() => new Promise(() => {}));

    const view = render(<ComposeModal {...baseProps} account="alice" accountEmail="alice@example.com" />);
    expect(await screen.findByText(/Alice signature/)).toBeVisible();

    view.rerender(<ComposeModal {...baseProps} account="bob" accountEmail="bob@example.com" />);
    await waitFor(() => expect(screen.queryByText(/Alice signature/)).not.toBeInTheDocument());
  });

  it('surfaces signature discovery failures instead of silently omitting the signature', async () => {
    mocks.apiFetch.mockRejectedValue(new Error('Signature service unavailable'));

    render(<ComposeModal {...baseProps} account="alice" accountEmail="alice@example.com" />);

    expect(await screen.findByText('Signature service unavailable')).toBeVisible();
  });
});

describe.each([
  { presentation: 'desktop', isMobile: false, closeName: 'Close compose window', editName: 'Edit email signature', saveName: 'Save Signature' },
  { presentation: 'mobile', isMobile: true, closeName: 'Close message composer', editName: 'Edit signature', saveName: 'Save' },
])('ComposeModal $presentation interaction ownership', ({ isMobile, closeName, editName, saveName }) => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.apiSendWithAttachments.mockReset();
    baseProps.onClose.mockReset();
    baseProps.onSent.mockReset();
  });

  it('uses the viewport modal foundation while preserving the presentation shape', () => {
    mocks.apiFetch.mockResolvedValue({ signature: '', signatureHtml: '' });

    render(<ComposeModal {...baseProps} isMobile={isMobile} />);

    const dialog = screen.getByRole('dialog', { name: 'New Email' });
    expect(dialog.closest('[data-viewport-modal-layer="true"]')).not.toBeNull();
    if (isMobile) {
      expect(dialog).toHaveClass('h-full', 'w-full');
    } else {
      expect(dialog).toHaveClass('max-h-[calc(100dvh-2rem)]', 'max-w-2xl');
    }
  });

  it('single-flights same-frame clicks and Enter-equivalent form submits', async () => {
    const pending = mockPendingSend();
    const onMutationChange = vi.fn();
    render(<ComposeModal {...baseProps} isMobile={isMobile} account="mailbox-1" onMutationChange={onMutationChange} />);
    fillValidMessage();

    const sendButton = screen.getByRole('button', { name: 'Send message' });
    const form = sendButton.closest('form');
    expect(form).not.toBeNull();

    act(() => {
      sendButton.click();
      sendButton.click();
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(mocks.apiFetch.mock.calls.filter(([path]) => path === '/send')).toHaveLength(1);
    const busyButton = await screen.findByRole('button', { name: 'Sending message' });
    expect(busyButton).toBe(sendButton);
    expect(busyButton).toBeDisabled();
    expect(busyButton).toHaveAttribute('aria-busy', 'true');
    expect(document.querySelectorAll('[aria-busy="true"]')).toHaveLength(1);
    expect(onMutationChange).toHaveBeenNthCalledWith(1, {
      kind: 'send',
      label: 'Sending message',
      account: 'mailbox-1',
    });
    expect(Object.isFrozen(onMutationChange.mock.calls[0][0])).toBe(true);

    await act(async () => {
      pending.resolve({});
      await pending.promise;
    });
    expect(baseProps.onSent).toHaveBeenCalledTimes(1);
    expect(baseProps.onClose).toHaveBeenCalledTimes(1);
    expect(onMutationChange).toHaveBeenLastCalledWith(null);
  });

  it('blocks close controls, Escape, and backdrop before and during an indeterminate send', async () => {
    const pending = mockPendingSend();
    render(<ComposeModal {...baseProps} isMobile={isMobile} />);
    fillValidMessage();

    const sendButton = screen.getByRole('button', { name: 'Send message' });
    const closeButton = screen.getByRole('button', { name: closeName });
    const modalLayer = document.querySelector<HTMLElement>('[data-viewport-modal-layer="true"]');
    expect(modalLayer).not.toBeNull();

    act(() => {
      sendButton.click();
      closeButton.click();
      modalLayer?.click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(baseProps.onClose).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Sending message' })).toBeDisabled();
    expect(closeButton).toBeDisabled();

    fireEvent.keyDown(document, { key: 'Escape' });
    if (!isMobile) {
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    }
    fireEvent.click(modalLayer!);

    expect(baseProps.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'New Email' })).toBeVisible();

    await act(async () => {
      pending.resolve({});
      await pending.promise;
    });
    expect(baseProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('single-flights an immutable signature save and blocks send or dismissal until it settles', async () => {
    const firstSave = deferred<unknown>();
    let saveAttempts = 0;
    mocks.apiFetch.mockImplementation((path: string, options?: { method?: string }) => {
      if (path === '/signature' && options?.method === 'PUT') {
        saveAttempts += 1;
        return saveAttempts === 1 ? firstSave.promise : Promise.resolve({ success: true });
      }
      if (path === '/signature') return Promise.resolve({ signature: '', signatureHtml: '' });
      if (path === '/send') return Promise.resolve({ success: true });
      return Promise.resolve({});
    });

    render(<ComposeModal {...baseProps} isMobile={isMobile} account="mailbox-1" />);
    fillValidMessage();
    await userEvent.click(screen.getByRole('button', { name: editName }));
    const signatureInput = screen.getByLabelText('Email signature');
    fireEvent.change(signatureInput, { target: { value: 'Team signature' } });
    const save = screen.getByRole('button', { name: saveName });
    const close = screen.getByRole('button', { name: closeName });
    const modalLayer = document.querySelector<HTMLElement>('[data-viewport-modal-layer="true"]');

    act(() => {
      save.click();
      save.click();
      screen.getByRole('button', { name: 'Send message' }).click();
      close.click();
      modalLayer?.click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(saveAttempts).toBe(1);
    expect(mocks.apiFetch).toHaveBeenCalledWith('/signature', {
      method: 'PUT',
      body: JSON.stringify({ signature: 'Team signature', signatureHtml: '' }),
      account: 'mailbox-1',
    });
    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-busy', 'true');
    expect(document.querySelectorAll('[aria-busy="true"]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(close).toBeDisabled();
    expect(signatureInput).toBeDisabled();
    screen.getAllByRole('button', { name: 'Cancel' }).forEach((cancel) => expect(cancel).toBeDisabled());
    expect(baseProps.onClose).not.toHaveBeenCalled();
    expect(mocks.apiFetch.mock.calls.filter(([path]) => path === '/send')).toHaveLength(0);

    await act(async () => {
      firstSave.reject(new Error('Signature update could not be committed'));
      await firstSave.promise.catch(() => undefined);
    });
    expect((await screen.findAllByText('Signature update could not be committed')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: saveName })).toBeEnabled();
    expect(screen.getByRole('dialog', { name: 'New Email' })).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: saveName }));
    await waitFor(() => expect(saveAttempts).toBe(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: saveName })).not.toBeInTheDocument());
  });
});

describe('ComposeModal focus restoration', () => {
  it('returns focus to the compose trigger after a normal dismissal', async () => {
    mocks.apiFetch.mockResolvedValue({ signature: '', signatureHtml: '' });
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open composer</button>
          {open && (
            <ComposeModal
              {...baseProps}
              onClose={() => setOpen(false)}
            />
          )}
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open composer' });
    await user.click(trigger);
    expect(await screen.findByLabelText('To')).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Close compose window' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
