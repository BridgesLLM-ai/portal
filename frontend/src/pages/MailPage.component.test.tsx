// @vitest-environment jsdom
import '../test/setup';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MailPage from './MailPage';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  fetchMailAccounts: vi.fn(),
  shellAction: vi.fn(),
  transientAction: vi.fn(),
  publicSettings: {
    current: {
      originMode: 'domain',
      mail: { available: true, reason: null },
    } as any,
  },
}));

vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../hooks/usePublicSettings', () => ({
  usePublicSettings: () => mocks.publicSettings.current,
}));

vi.mock('../components/mail/api', () => ({
  apiFetch: mocks.apiFetch,
  fetchMailAccounts: mocks.fetchMailAccounts,
}));

vi.mock('../components/mail/MailSidebar', () => ({
  default: (props: {
    interactionBlocked?: boolean;
    onSelectMailbox: (role: string) => void;
    onCompose: () => void;
    onClose: () => void;
    onSetupGuide?: () => void;
    onForwardSettings?: () => void;
    children?: React.ReactNode;
  }) => (
    <aside>
      Mailbox navigation
      <span data-testid="mail-parent-boundary">{props.interactionBlocked ? 'blocked' : 'idle'}</span>
      <button type="button" disabled={props.interactionBlocked} onClick={() => props.onSelectMailbox('sent')}>Open Sent mailbox</button>
      <button type="button" disabled={props.interactionBlocked} onClick={props.onCompose}>Compose from sidebar</button>
      <button type="button" disabled={props.interactionBlocked} onClick={props.onClose}>Close mailbox navigation</button>
      {props.onSetupGuide && <button type="button" disabled={props.interactionBlocked} onClick={props.onSetupGuide}>Open setup guide</button>}
      {props.onForwardSettings && <button type="button" disabled={props.interactionBlocked} onClick={props.onForwardSettings}>Open forwarding settings</button>}
      {props.children}
    </aside>
  ),
}));

vi.mock('../components/mail/EmailList', () => ({
  default: (props: {
    emails: Array<{ id: string; subject: string }>;
    error: string;
    account?: string;
    onMutationChange?: (activity: { kind: string; label: string; account?: string } | null) => void;
    onSelectEmail: (id: string) => void;
    onSearchChange: (query: string) => void;
    onPageChange: (page: number) => void;
    onOpenSidebar: () => void;
  }) => (
    <section>
      <span data-testid="active-mail-account">{props.account}</span>
      <button onClick={() => props.onMutationChange?.(Object.freeze({ kind: 'bulk-trash', label: 'Moving selected messages to Trash', account: props.account }))}>Start list mutation</button>
      <button onClick={() => props.onMutationChange?.(null)}>Finish list mutation</button>
      <button onClick={() => props.onSelectEmail('email-1')}>Open first message</button>
      <button onClick={() => props.onSearchChange('invoice 2026')}>Search full mailbox</button>
      <button onClick={() => props.onPageChange(1)}>Open next page</button>
      <button onClick={props.onOpenSidebar}>Open mobile mailbox navigation</button>
      {props.error ? <div role="alert">{props.error}</div> : null}
      {props.emails.map((email) => <div key={email.id}>{email.subject}</div>)}
    </section>
  ),
}));

vi.mock('../components/mail/EmailDetail', () => ({
  default: (props: {
    account?: string;
    onMutationChange?: (activity: { kind: string; label: string; account?: string } | null) => void;
    onBack: () => void;
  }) => (
    <section aria-label="Message detail">
      <button onClick={() => props.onMutationChange?.(Object.freeze({ kind: 'trash', label: 'Moving message to Trash', account: props.account }))}>Start detail mutation</button>
      <button onClick={() => props.onMutationChange?.(null)}>Finish detail mutation</button>
      <button onClick={props.onBack}>Back to message list</button>
    </section>
  ),
}));

vi.mock('../components/mail/ComposeModal', () => ({
  default: (props: {
    account?: string;
    onMutationChange?: (activity: { kind: string; label: string; account?: string } | null) => void;
    onClose: () => void;
  }) => (
    <section aria-label="Message composer">
      <button onClick={() => props.onMutationChange?.(Object.freeze({ kind: 'send', label: 'Sending message', account: props.account }))}>Start compose mutation</button>
      <button onClick={() => props.onMutationChange?.(null)}>Finish compose mutation</button>
      <button onClick={props.onClose}>Close composer</button>
    </section>
  ),
}));

const initialEmail = {
  id: 'email-1',
  subject: 'Quarterly update',
  preview: '',
  from: [],
  receivedAt: '2026-07-19T12:00:00.000Z',
};

const matchingEmail = {
  ...initialEmail,
  id: 'email-2',
  subject: 'Invoice 2026',
};

function renderMailPage() {
  function NavigationProbe() {
    const navigate = useNavigate();
    const location = useLocation();
    return (
      <>
        <button type="button" onClick={() => navigate('/settings')}>Programmatic parent route</button>
        <button type="button" onClick={mocks.shellAction}>Logout shell action</button>
        <div data-viewport-transient-overlay="true">
          <button type="button" onClick={mocks.transientAction}>Active Mail overlay action</button>
        </div>
        <output data-testid="parent-route">{location.pathname}</output>
      </>
    );
  }

  return render(
    <MemoryRouter>
      <NavigationProbe />
      <MailPage />
    </MemoryRouter>,
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('MailPage mailbox search and error ownership', () => {
  beforeEach(() => {
    mocks.shellAction.mockReset();
    mocks.transientAction.mockReset();
    mocks.publicSettings.current = {
      originMode: 'domain',
      mail: { available: true, reason: null },
    };
    mocks.fetchMailAccounts.mockReset().mockResolvedValue({
      accounts: [{ id: 'mailbox-1', label: 'alice', email: 'alice@example.com', kind: 'personal', isPrimary: true }],
      hasMailbox: true,
    });
    mocks.apiFetch.mockReset().mockImplementation(async (path: string) => {
      if (path === '/mailboxes') {
        return { mailboxes: [{ id: 'inbox-id', name: 'Inbox', role: 'inbox', totalEmails: 1, unreadEmails: 0 }] };
      }
      if (path.startsWith('/messages?') && path.includes('query=invoice+2026')) {
        return { emails: [matchingEmail], total: 1, position: 0 };
      }
      if (path.startsWith('/messages?')) {
        return { emails: [initialEmail], total: 1, position: 0 };
      }
      throw new Error(`Unexpected mail API path: ${path}`);
    });
  });

  it('debounces search into the server query so results cover the full mailbox', async () => {
    const user = userEvent.setup();
    renderMailPage();

    expect(await screen.findByText('Quarterly update')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Search full mailbox' }));

    await waitFor(() => {
      expect(mocks.apiFetch).toHaveBeenCalledWith(
        expect.stringContaining('query=invoice+2026'),
        { account: 'mailbox-1' },
      );
    });
    expect(await screen.findByText('Invoice 2026')).toBeVisible();
  });

  it('keeps a message-list error inside the list when mailbox discovery is healthy', async () => {
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/mailboxes') {
        return { mailboxes: [{ id: 'inbox-id', name: 'Inbox', role: 'inbox', totalEmails: 1, unreadEmails: 0 }] };
      }
      if (path.startsWith('/messages?')) throw new Error('Message query failed');
      throw new Error(`Unexpected mail API path: ${path}`);
    });

    renderMailPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Message query failed');
    expect(screen.queryByText('Mail server connection failed')).not.toBeInTheDocument();
  });

  it('fails closed when mail account discovery is unavailable', async () => {
    mocks.fetchMailAccounts.mockRejectedValue(new Error('Mail account discovery is unavailable'));

    renderMailPage();

    expect(await screen.findByText('Mail server connection failed')).toBeVisible();
    expect(screen.getByText('Mail account discovery is unavailable')).toBeVisible();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('does not mount the mail workspace when this installation cannot host mail', async () => {
    mocks.publicSettings.current = {
      originMode: 'tailnet',
      mail: {
        available: false,
        reason: 'Mail requires a public domain and is unavailable in private Tailnet mode.',
      },
    };

    renderMailPage();

    expect(screen.getByText('Private Tailnet mode')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Mail requires a public domain' })).toBeVisible();
    expect(screen.getByText(/unavailable in private Tailnet mode/i)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Review domain settings' })).toHaveAttribute(
      'href',
      '/settings?tab=general',
    );
    expect(mocks.fetchMailAccounts).not.toHaveBeenCalled();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('does not mount or poll the mail workspace while capability truth is unresolved', () => {
    mocks.publicSettings.current = null;

    renderMailPage();

    expect(screen.getByText('Checking mail availability…')).toHaveAttribute('role', 'status');
    expect(mocks.fetchMailAccounts).not.toHaveBeenCalled();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('stops waiting on unresolved capability truth and offers a way forward', async () => {
    // the capability gate had no timeout and no failure branch, so
    // public settings that never arrived left the page spinning indefinitely.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mocks.publicSettings.current = null;
      renderMailPage();
      expect(screen.getByText('Checking mail availability…')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(screen.getByText('Mail availability could not be confirmed')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
      expect(screen.getByRole('link', { name: 'Go to Settings' })).toBeInTheDocument();
      expect(mocks.fetchMailAccounts).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('owns setup-guide interaction and replaces an endless spinner with a retryable load error', async () => {
    const user = userEvent.setup();
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/mailboxes') return { mailboxes: [] };
      if (path.startsWith('/messages?')) return { emails: [], total: 0 };
      if (path === '/credentials') throw new Error('Credential service unavailable');
      throw new Error(`Unexpected mail API path: ${path}`);
    });

    renderMailPage();
    const trigger = await screen.findByRole('button', { name: 'Open setup guide' });
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: '📱 Connect Your Phone' });
    expect(dialog.closest('[data-viewport-overlay-root="true"]')?.parentElement).toBe(document.body);
    expect(await screen.findByRole('alert')).toHaveTextContent('Credential service unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('single-flights password reveal and keeps the owning dialog open while the request is pending', async () => {
    const user = userEvent.setup();
    const reveal = deferred<any>();
    mocks.apiFetch.mockImplementation((path: string) => {
      if (path === '/mailboxes') return Promise.resolve({ mailboxes: [] });
      if (path.startsWith('/messages?')) return Promise.resolve({ emails: [], total: 0 });
      if (path === '/credentials') {
        return Promise.resolve({
          username: 'alice', email: 'alice@example.com', passwordRequired: true,
          imap: { server: 'mail.example.com', port: 993, security: 'TLS' },
          smtp: { server: 'mail.example.com', port: 465, security: 'TLS' },
        });
      }
      if (path === '/credentials/reveal') return reveal.promise;
      return Promise.reject(new Error(`Unexpected mail API path: ${path}`));
    });

    renderMailPage();
    await user.click(await screen.findByRole('button', { name: 'Open setup guide' }));
    const password = await screen.findByLabelText(/Confirm your Portal password/i);
    await user.type(password, 'correct horse battery staple');
    const revealButton = screen.getByRole('button', { name: 'Reveal mail password' });

    act(() => {
      revealButton.click();
      revealButton.click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(mocks.apiFetch.mock.calls.filter(([path]) => path === '/credentials/reveal')).toHaveLength(1);
    expect(await screen.findByRole('button', { name: 'Revealing mail password' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Close mail setup guide' })).toBeDisabled();
    expect(screen.getByRole('dialog', { name: '📱 Connect Your Phone' })).toBeVisible();

    await act(async () => {
      reveal.resolve({
        username: 'alice', email: 'alice@example.com', password: 'mail-secret',
        imap: { server: 'mail.example.com', port: 993, security: 'TLS' },
        smtp: { server: 'mail.example.com', port: 465, security: 'TLS' },
      });
      await reveal.promise;
    });
    expect(screen.getByRole('button', { name: 'Hide mail password' })).toBeVisible();
  });

  it('single-flights forwarding saves, blocks dismissal while pending, and keeps errors in the dialog', async () => {
    const user = userEvent.setup();
    const save = deferred<any>();
    mocks.apiFetch.mockImplementation((path: string, options?: { method?: string }) => {
      if (path === '/mailboxes') return Promise.resolve({ mailboxes: [] });
      if (path.startsWith('/messages?')) return Promise.resolve({ emails: [], total: 0 });
      if (path === '/forward-settings' && options?.method === 'PUT') return save.promise;
      if (path === '/forward-settings') return Promise.resolve({ autoForwardTo: '' });
      return Promise.reject(new Error(`Unexpected mail API path: ${path}`));
    });

    renderMailPage();
    const programmaticRoute = screen.getByRole('button', { name: 'Programmatic parent route' });
    const trigger = await screen.findByRole('button', { name: 'Open forwarding settings' });
    await user.click(trigger);
    const input = await screen.findByLabelText('Forward to email address');
    await user.type(input, 'owner@example.com');
    const saveButton = screen.getByRole('button', { name: 'Save forwarding settings' });
    const form = saveButton.closest('form');

    act(() => {
      saveButton.click();
      saveButton.click();
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      programmaticRoute.click();
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(mocks.apiFetch.mock.calls.filter(([path, options]) => path === '/forward-settings' && options?.method === 'PUT')).toHaveLength(1);
    expect(await screen.findByRole('button', { name: 'Saving forwarding settings' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('dialog', { name: 'Auto-Forward Emails' })).toBeVisible();
    expect(screen.getByTestId('mail-parent-boundary')).toHaveTextContent('blocked');
    expect(screen.getByTestId('parent-route')).toHaveTextContent('/');
    const beforeUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);

    await act(async () => {
      save.reject(new Error('Forwarding update failed'));
      try { await save.promise; } catch { /* asserted in the UI */ }
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Forwarding update failed');
    expect(screen.getByRole('dialog', { name: 'Auto-Forward Emails' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save forwarding settings' })).toBeEnabled();
    expect(screen.getByTestId('mail-parent-boundary')).toHaveTextContent('idle');
    await user.click(programmaticRoute);
    await waitFor(() => expect(screen.getByTestId('parent-route')).toHaveTextContent('/settings'));
  });

  it('does not present an empty forwarding form when current settings fail to load', async () => {
    const user = userEvent.setup();
    mocks.apiFetch.mockImplementation((path: string) => {
      if (path === '/mailboxes') return Promise.resolve({ mailboxes: [] });
      if (path.startsWith('/messages?')) return Promise.resolve({ emails: [], total: 0 });
      if (path === '/forward-settings') return Promise.reject(new Error('Forwarding service unavailable'));
      return Promise.reject(new Error(`Unexpected mail API path: ${path}`));
    });

    renderMailPage();
    await user.click(await screen.findByRole('button', { name: 'Open forwarding settings' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Forwarding service unavailable');
    expect(screen.queryByLabelText('Forward to email address')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save forwarding settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('locks account, mailbox, search, pagination, compose, and route boundaries in the admission frame', async () => {
    const user = userEvent.setup();
    mocks.fetchMailAccounts.mockResolvedValue({
      accounts: [
        { id: 'mailbox-1', label: 'Alice', email: 'alice@example.com', kind: 'personal', isPrimary: true },
        { id: 'mailbox-2', label: 'Support', email: 'support@example.com', kind: 'shared', isPrimary: false },
      ],
      hasMailbox: true,
    });

    renderMailPage();
    expect(await screen.findByText('Quarterly update')).toBeVisible();
    expect(screen.getByTestId('active-mail-account')).toHaveTextContent('mailbox-1');

    const accountTrigger = screen.getByRole('button', { name: /Alice.*alice@example\.com/i });
    const start = screen.getByRole('button', { name: 'Start list mutation' });
    const search = screen.getByRole('button', { name: 'Search full mailbox' });
    const nextPage = screen.getByRole('button', { name: 'Open next page' });
    const sentMailbox = screen.getByRole('button', { name: 'Open Sent mailbox' });
    const compose = screen.getByRole('button', { name: 'Compose from sidebar' });
    const programmaticRoute = screen.getByRole('button', { name: 'Programmatic parent route' });
    const shellAction = screen.getByRole('button', { name: 'Logout shell action' });
    const transientAction = screen.getByRole('button', { name: 'Active Mail overlay action' });
    const routeLink = document.createElement('a');
    routeLink.href = '/settings';
    routeLink.textContent = 'Leave Mail';
    document.body.appendChild(routeLink);
    const priorHistoryState = window.history.state;
    window.history.replaceState({ ...(priorHistoryState || {}), idx: 9 }, '');
    const historyGo = vi.spyOn(window.history, 'go').mockImplementation(() => undefined);
    let routeClickWasPrevented = false;

    act(() => {
      start.click();
      search.click();
      nextPage.click();
      sentMailbox.click();
      compose.click();
      programmaticRoute.click();
      fireEvent.pointerDown(shellAction);
      fireEvent.click(shellAction);
      fireEvent.pointerDown(transientAction);
      fireEvent.click(transientAction);
      routeClickWasPrevented = !routeLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(routeClickWasPrevented).toBe(true);
    expect(mocks.shellAction).not.toHaveBeenCalled();
    expect(mocks.transientAction).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('mail-parent-boundary')).toHaveTextContent('blocked'));
    expect(screen.getByTestId('active-mail-account')).toHaveTextContent('mailbox-1');
    expect(accountTrigger).toBeDisabled();
    expect(sentMailbox).toBeDisabled();
    expect(compose).toBeDisabled();
    expect(screen.queryByRole('region', { name: 'Message composer' })).not.toBeInTheDocument();
    expect(screen.getByTestId('parent-route')).toHaveTextContent('/');

    const beforeUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);
    window.history.replaceState({ ...(window.history.state || {}), idx: 8 }, '');
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    expect(historyGo).toHaveBeenCalledWith(1);

    await new Promise(resolve => window.setTimeout(resolve, 350));
    const messageRequests = mocks.apiFetch.mock.calls
      .filter(([path]) => typeof path === 'string' && path.startsWith('/messages?'))
      .map(([path]) => String(path));
    expect(messageRequests.some(path => path.includes('query=invoice+2026'))).toBe(false);
    expect(messageRequests.some(path => path.includes('position=50'))).toBe(false);
    expect(messageRequests.some(path => path.includes('mailboxRole=sent'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Finish list mutation' }));
    await waitFor(() => expect(screen.getByTestId('mail-parent-boundary')).toHaveTextContent('idle'));
    const inactiveBeforeUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(inactiveBeforeUnload);
    expect(inactiveBeforeUnload.defaultPrevented).toBe(false);
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    expect(historyGo).toHaveBeenCalledTimes(1);

    await user.click(shellAction);
    expect(mocks.shellAction).toHaveBeenCalledTimes(1);

    await user.click(accountTrigger);
    await user.click(await screen.findByRole('menuitemradio', { name: /Support.*support@example\.com/i }));
    await waitFor(() => expect(screen.getByTestId('active-mail-account')).toHaveTextContent('mailbox-2'));
    await user.click(programmaticRoute);
    await waitFor(() => expect(screen.getByTestId('parent-route')).toHaveTextContent('/settings'));
    historyGo.mockRestore();
    window.history.replaceState(priorHistoryState, '');
    routeLink.remove();
  });

  it('carries ownership through detail and compose surfaces without leaving stale page locks', async () => {
    const user = userEvent.setup();
    renderMailPage();
    expect(await screen.findByText('Quarterly update')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Open first message' }));
    expect(await screen.findByRole('region', { name: 'Message detail' })).toBeVisible();
    const sentMailbox = screen.getByRole('button', { name: 'Open Sent mailbox' });
    const composeFromSidebar = screen.getByRole('button', { name: 'Compose from sidebar' });

    act(() => {
      screen.getByRole('button', { name: 'Start detail mutation' }).click();
      sentMailbox.click();
      composeFromSidebar.click();
    });
    expect(screen.getByTestId('mail-parent-boundary')).toHaveTextContent('blocked');
    expect(screen.getByRole('region', { name: 'Message detail' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Message composer' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Finish detail mutation' }));
    await waitFor(() => expect(screen.getByTestId('mail-parent-boundary')).toHaveTextContent('idle'));
    await user.click(composeFromSidebar);
    expect(await screen.findByRole('region', { name: 'Message composer' })).toBeVisible();

    act(() => {
      screen.getByRole('button', { name: 'Start compose mutation' }).click();
      sentMailbox.click();
    });
    expect(screen.getByTestId('mail-parent-boundary')).toHaveTextContent('blocked');
    expect(screen.getByRole('region', { name: 'Message composer' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Finish compose mutation' }));
    await waitFor(() => expect(screen.getByTestId('mail-parent-boundary')).toHaveTextContent('idle'));
    await user.click(screen.getByRole('button', { name: 'Close composer' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Message composer' })).not.toBeInTheDocument());
  });
});
