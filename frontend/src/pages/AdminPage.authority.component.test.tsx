// @vitest-environment jsdom
import '../test/setup';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminUser,
  RegistrationApprovalResponse,
  RegistrationRequest,
} from '../api/admin';
import AdminPage from './AdminPage';

const mocks = vi.hoisted(() => ({
  listUsers: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
  transferOwnership: vi.fn(),
  listRegistrationRequests: vi.fn(),
  approveRequest: vi.fn(),
  denyRequest: vi.fn(),
  getMaintenanceStatus: vi.fn(),
  startMaintenanceAction: vi.fn(),
  listJobs: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuthStore: () => ({
    user: { id: 'owner-1', email: 'owner@example.com', username: 'owner', role: 'OWNER' },
  }),
}));

vi.mock('../api/admin', () => ({
  adminAPI: {
    listUsers: mocks.listUsers,
    updateUser: mocks.updateUser,
    deleteUser: mocks.deleteUser,
    transferOwnership: mocks.transferOwnership,
    listRegistrationRequests: mocks.listRegistrationRequests,
    approveRequest: mocks.approveRequest,
    denyRequest: mocks.denyRequest,
  },
}));

vi.mock('../api/maintenance', () => ({
  maintenanceAPI: {
    getStatus: mocks.getMaintenanceStatus,
    startAction: mocks.startMaintenanceAction,
  },
}));

vi.mock('../api/agentJobs', () => ({
  agentJobsAPI: { list: mocks.listJobs },
}));

vi.mock('../utils/sounds', () => ({
  default: { click: vi.fn(), success: vi.fn(), delete: vi.fn(), error: vi.fn() },
}));

const alice: AdminUser = {
  id: 'user-a',
  email: 'alice@example.com',
  username: 'Alice',
  role: 'USER',
  accountStatus: 'ACTIVE',
  isActive: true,
  sandboxEnabled: true,
  createdAt: '2026-07-01T12:00:00.000Z',
};

const bob: AdminUser = {
  id: 'user-b',
  email: 'bob@example.com',
  username: 'Bob',
  role: 'SUB_ADMIN',
  accountStatus: 'ACTIVE',
  isActive: true,
  sandboxEnabled: false,
  createdAt: '2026-07-02T12:00:00.000Z',
};

const authorizationSafetyReady = {
  ready: true,
  code: 'TEST_AUTHORIZATION_READY',
  message: 'Authorization transitions are available in this isolated UI test.',
  fixedGenerationProjectExecution: true,
  authorizationScopeChanges: true,
  retryable: false,
};

const authorizationSafetyBlocked = {
  ready: false,
  code: 'PROJECT_RUNTIME_AUTHORIZATION_UNPROVEN',
  message: 'Authorization-changing user and workspace operations are disabled because Portal cannot yet prove every Project provider runtime is stopped across authorization changes and restart.',
  fixedGenerationProjectExecution: true,
  authorizationScopeChanges: false,
  retryable: false,
};

const requestA: RegistrationRequest = {
  id: 'request-a',
  email: 'new-a@example.com',
  name: 'New A',
  message: null,
  status: 'PENDING',
  requestedAt: '2026-07-20T12:00:00.000Z',
};

const requestB: RegistrationRequest = {
  id: 'request-b',
  email: 'new-b@example.com',
  name: 'New B',
  message: null,
  status: 'PENDING',
  requestedAt: '2026-07-20T13:00:00.000Z',
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

function renderAdmin(path = '/admin') {
  return render(
    <MemoryRouter
      initialEntries={[path]}
    >
      <AdminPage />
    </MemoryRouter>,
  );
}

async function approveFirstPendingRequest(
  response: RegistrationApprovalResponse,
  pendingRequests: RegistrationRequest[] = [requestA, requestB],
) {
  mocks.listRegistrationRequests.mockResolvedValueOnce({
    requests: pendingRequests,
    total: pendingRequests.length,
    page: 1,
    pages: 1,
  });
  mocks.approveRequest.mockResolvedValueOnce(response);
  const user = userEvent.setup();
  renderAdmin('/admin?tab=pending');
  const applicantEmail = pendingRequests[0].email;
  await user.click((await screen.findAllByRole('button', { name: 'Approve' }))[0]);
  await waitFor(() => expect(screen.queryByText(applicantEmail)).not.toBeInTheDocument());
  return screen.getByRole('status');
}

let shellNavigate: NavigateFunction | null = null;

function AdminShell({ onLogout }: { onLogout: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  shellNavigate = navigate;

  return (
    <div data-testid="admin-shell">
      <nav aria-label="Test shell navigation">
        <Link to="/settings">Shell settings</Link>
        <button type="button" onClick={() => navigate('/dashboard')}>Shell dashboard</button>
        <button type="button" onClick={onLogout}>Logout</button>
      </nav>
      <span data-testid="shell-path">{location.pathname}</span>
      <AdminPage />
    </div>
  );
}

function renderAdminWithShell(path = '/admin') {
  const logout = vi.fn();
  const rendered = render(
    <MemoryRouter
      initialEntries={['/previous', path]}
      initialIndex={1}
    >
      <AdminShell onLogout={logout} />
    </MemoryRouter>,
  );
  return { ...rendered, logout };
}

describe('AdminPage authority mutation admission', () => {
  beforeEach(() => {
    shellNavigate = null;
    mocks.listUsers.mockReset().mockResolvedValue({
      users: [alice, bob],
      total: 2,
      page: 1,
      pages: 1,
      authorizationSafety: authorizationSafetyReady,
    });
    mocks.updateUser.mockReset().mockResolvedValue(alice);
    mocks.deleteUser.mockReset();
    mocks.transferOwnership.mockReset().mockResolvedValue({ success: true });
    mocks.listRegistrationRequests.mockReset().mockResolvedValue({ requests: [requestA, requestB], total: 2, page: 1, pages: 1 });
    mocks.approveRequest.mockReset().mockResolvedValue({ success: true });
    mocks.denyRequest.mockReset().mockResolvedValue({ success: true });
    mocks.getMaintenanceStatus.mockReset();
    mocks.startMaintenanceAction.mockReset();
    mocks.listJobs.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    shellNavigate = null;
    window.history.replaceState({ idx: 0 }, '', '/');
  });

  it('truthfully disables authorization transitions while fixed-generation Project Chat remains available', async () => {
    mocks.listUsers.mockResolvedValueOnce({
      users: [alice, bob],
      total: 2,
      page: 1,
      pages: 1,
      authorizationSafety: authorizationSafetyBlocked,
    });
    renderAdmin();

    const note = await screen.findByRole('note', { name: 'Authorization changes unavailable' });
    expect(note).toHaveTextContent(authorizationSafetyBlocked.message);
    expect(note).toHaveTextContent('Fixed-generation Project Chat remains available.');

    const role = screen.getByRole('combobox', { name: 'Role for bob@example.com' });
    const status = screen.getByRole('combobox', { name: 'Account status for alice@example.com' });
    const workspace = screen.getByRole('switch', { name: 'Use private project workspace for bob@example.com' });
    const aliceRow = screen.getByText('alice@example.com').closest('tr');
    expect(aliceRow).not.toBeNull();
    const transfer = within(aliceRow!).getByRole('button', { name: 'Transfer' });

    expect(role).toBeDisabled();
    expect(status).toBeDisabled();
    expect(workspace).toBeDisabled();
    expect(transfer).toBeDisabled();
    expect(role).toHaveAttribute('aria-describedby', 'admin-authorization-transition-note');
    expect(transfer).toHaveAttribute('aria-describedby', 'admin-authorization-transition-note');

    fireEvent.change(role, { target: { value: 'USER' } });
    fireEvent.change(status, { target: { value: 'BANNED' } });
    fireEvent.click(workspace);
    fireEvent.click(transfer);

    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.transferOwnership).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: /Transfer ownership/ })).not.toBeInTheDocument();
  });

  it('admits one exact direct user mutation and rejects same-frame sibling controls', async () => {
    const pendingUpdate = deferred<typeof alice>();
    mocks.updateUser.mockReturnValueOnce(pendingUpdate.promise);
    renderAdmin();

    const role = await screen.findByRole('combobox', { name: 'Role for bob@example.com' });
    const status = screen.getByRole('combobox', { name: 'Account status for alice@example.com' });
    const workspace = screen.getByRole('switch', { name: 'Use private project workspace for bob@example.com' });
    const pendingTab = screen.getByRole('tab', { name: 'Pending Approvals' });

    act(() => {
      fireEvent.change(role, { target: { value: 'USER' } });
      fireEvent.change(status, { target: { value: 'DISABLED' } });
      workspace.click();
    });

    expect(mocks.updateUser).toHaveBeenCalledTimes(1);
    expect(mocks.updateUser).toHaveBeenCalledWith('user-b', { role: 'USER' });
    expect(await screen.findByRole('status')).toHaveTextContent('Updating role…');
    expect(role).toHaveAttribute('aria-busy', 'true');
    expect(status).toBeDisabled();
    expect(workspace).toBeDisabled();
    expect(pendingTab).toBeDisabled();

    await act(async () => {
      pendingUpdate.resolve({ ...bob, role: 'USER' });
      await pendingUpdate.promise;
    });

    await waitFor(() => expect(screen.queryByText('Updating role…')).not.toBeInTheDocument());
    expect(screen.getByRole('combobox', { name: 'Account status for alice@example.com' })).toBeEnabled();
  });

  it('owns the whole route and shell while an inline authority mutation is unsettled', async () => {
    const pendingUpdate = deferred<typeof bob>();
    mocks.updateUser.mockReturnValueOnce(pendingUpdate.promise);
    window.history.replaceState({ idx: 7 }, '', '/admin-browser');
    const historyGo = vi.spyOn(window.history, 'go').mockImplementation(() => undefined);
    const { container, logout } = renderAdminWithShell();

    const role = await screen.findByRole('combobox', { name: 'Role for bob@example.com' });
    const shellSettings = screen.getByRole('link', { name: 'Shell settings' });
    const shellDashboard = screen.getByRole('button', { name: 'Shell dashboard' });
    const logoutButton = screen.getByRole('button', { name: 'Logout' });

    fireEvent.change(role, { target: { value: 'USER' } });

    const progressDialog = await screen.findByRole('dialog', { name: 'Admin authority update in progress' });
    expect(progressDialog).toHaveAttribute('aria-busy', 'true');
    expect(within(progressDialog).getByRole('status')).toHaveTextContent('Updating role…');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(container).toHaveAttribute('inert');
    expect(container).toHaveAttribute('aria-hidden', 'true');

    const blockedUnload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(blockedUnload)).toBe(false);
    expect(blockedUnload.defaultPrevented).toBe(true);

    act(() => {
      shellNavigate?.('/command-palette-target');
      shellNavigate?.('/replace-target', { replace: true });
      shellNavigate?.(-1);
    });
    expect(screen.getByTestId('shell-path')).toHaveTextContent('/admin');

    fireEvent.click(shellSettings);
    fireEvent.click(shellDashboard);
    fireEvent.click(logoutButton);
    expect(screen.getByTestId('shell-path')).toHaveTextContent('/admin');
    expect(logout).not.toHaveBeenCalled();

    window.history.replaceState({ idx: 6 }, '', '/previous-browser');
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    expect(historyGo).toHaveBeenCalledWith(1);

    await act(async () => {
      pendingUpdate.resolve({ ...bob, role: 'USER' });
      await pendingUpdate.promise;
    });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Admin authority update in progress' })).not.toBeInTheDocument());
    expect(container).not.toHaveAttribute('inert');
    expect(container).not.toHaveAttribute('aria-hidden');

    act(() => {
      shellNavigate?.('/dashboard');
    });
    expect(screen.getByTestId('shell-path')).toHaveTextContent('/dashboard');
    fireEvent.click(logoutButton);
    expect(logout).toHaveBeenCalledTimes(1);

    const releasedUnload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(releasedUnload)).toBe(true);
    expect(releasedUnload.defaultPrevented).toBe(false);
  });

  it('serializes exact status and workspace updates through the same admission owner', async () => {
    const pendingStatus = deferred<typeof alice>();
    const pendingWorkspace = deferred<typeof bob>();
    mocks.updateUser
      .mockReturnValueOnce(pendingStatus.promise)
      .mockReturnValueOnce(pendingWorkspace.promise);
    renderAdmin();

    const aliceStatus = await screen.findByRole('combobox', { name: 'Account status for alice@example.com' });
    const bobWorkspace = screen.getByRole('switch', { name: 'Use private project workspace for bob@example.com' });
    const bobRole = screen.getByRole('combobox', { name: 'Role for bob@example.com' });

    act(() => {
      fireEvent.change(aliceStatus, { target: { value: 'BANNED' } });
      bobWorkspace.click();
      fireEvent.change(bobRole, { target: { value: 'USER' } });
    });

    expect(mocks.updateUser).toHaveBeenCalledTimes(1);
    expect(mocks.updateUser).toHaveBeenLastCalledWith('user-a', { accountStatus: 'BANNED' });
    expect(await screen.findByRole('status')).toHaveTextContent('Updating account status…');
    expect(aliceStatus).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      pendingStatus.resolve({ ...alice, accountStatus: 'BANNED', isActive: false });
      await pendingStatus.promise;
    });

    await waitFor(() => expect(bobWorkspace).toBeEnabled());
    act(() => {
      bobWorkspace.click();
      bobWorkspace.click();
      fireEvent.change(aliceStatus, { target: { value: 'DISABLED' } });
    });

    expect(mocks.updateUser).toHaveBeenCalledTimes(2);
    expect(mocks.updateUser).toHaveBeenLastCalledWith('user-b', { sandboxEnabled: true });
    expect(await screen.findByText('Updating project workspace…')).toBeVisible();
    expect(bobWorkspace).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      pendingWorkspace.resolve({ ...bob, sandboxEnabled: true });
      await pendingWorkspace.promise;
    });

    await waitFor(() => expect(screen.queryByText('Updating project workspace…')).not.toBeInTheDocument());
  });

  it('snapshots promote confirmation and suppresses same-frame duplicate confirms', async () => {
    const user = userEvent.setup();
    mocks.updateUser.mockResolvedValueOnce({ ...alice, role: 'SUB_ADMIN' });
    renderAdmin();

    const aliceRole = await screen.findByRole('combobox', { name: 'Role for alice@example.com' });
    await user.selectOptions(aliceRole, 'SUB_ADMIN');
    const dialog = await screen.findByRole('dialog', { name: 'Promote Alice to SUB_ADMIN?' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Type GRANT SERVER ACCESS to continue/i }),
      'GRANT SERVER ACCESS',
    );
    const promote = within(dialog).getByRole('button', { name: 'Grant server access' });
    act(() => {
      promote.click();
      promote.click();
    });

    expect(mocks.updateUser).toHaveBeenCalledTimes(1);
    expect(mocks.updateUser).toHaveBeenLastCalledWith('user-a', {
      role: 'SUB_ADMIN',
      confirmation: 'GRANT SERVER ACCESS',
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Promote Alice to SUB_ADMIN?' })).not.toBeInTheDocument());
  });

  it('keeps identity-aware user deletion retired without issuing a request', async () => {
    renderAdmin();

    const retirementNote = await screen.findByRole('note', { name: 'User deletion unavailable' });
    expect(retirementNote).toHaveTextContent('Portal 4 identity-aware project and OpenClaw cleanup is retirement-pending.');

    const aliceRow = screen.getByText('alice@example.com').closest('tr');
    const bobRow = screen.getByText('bob@example.com').closest('tr');
    expect(aliceRow).not.toBeNull();
    expect(bobRow).not.toBeNull();
    const aliceDelete = within(aliceRow!).getByRole('button', { name: 'Delete alice@example.com unavailable' });
    const bobDelete = within(bobRow!).getByRole('button', { name: 'Delete bob@example.com unavailable' });

    expect(aliceDelete).toBeDisabled();
    expect(bobDelete).toBeDisabled();
    expect(bobDelete).toHaveAttribute('aria-describedby', 'admin-user-deletion-retirement-note');
    expect(within(bobRow!).getByRole('button', { name: 'Transfer' })).toBeEnabled();

    fireEvent.click(aliceDelete);
    fireEvent.click(bobDelete);

    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: /Delete (Alice|Bob)\?/ })).not.toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
  });

  it('keeps authority confirmation ownership through same-frame duplicates and retryable failure', async () => {
    const user = userEvent.setup();
    const pendingTransfer = deferred<{ success: boolean }>();
    mocks.transferOwnership.mockReturnValueOnce(pendingTransfer.promise);
    renderAdmin();

    const aliceRow = (await screen.findByText('alice@example.com')).closest('tr');
    expect(aliceRow).not.toBeNull();
    const transferTrigger = within(aliceRow!).getByRole('button', { name: 'Transfer' });
    const siblingStatus = screen.getByRole('combobox', { name: 'Account status for bob@example.com' });
    await user.click(transferTrigger);
    const dialog = await screen.findByRole('dialog', { name: 'Transfer ownership to Alice?' });
    const confirmation = within(dialog).getByRole('textbox', { name: /Type TRANSFER TO alice@example.com to continue/i });
    await user.type(confirmation, 'TRANSFER TO alice@example.com');
    const confirm = within(dialog).getByRole('button', { name: 'Transfer ownership' });
    act(() => {
      confirm.click();
      confirm.click();
      fireEvent.change(siblingStatus, { target: { value: 'BANNED' } });
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.click(dialog.closest('[data-viewport-modal-layer="true"]')!);
    });

    expect(mocks.transferOwnership).toHaveBeenCalledTimes(1);
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(await within(dialog).findByRole('button', { name: 'Transferring ownership…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('dialog', { name: 'Transfer ownership to Alice?' })).toBeVisible();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: 'Admin authority update in progress' })).not.toBeInTheDocument();

    await act(async () => {
      pendingTransfer.reject({ response: { data: { error: `Transfer preflight failed ${'x'.repeat(500)}` } } });
      await pendingTransfer.promise.catch(() => undefined);
    });

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Transfer preflight failed');
    expect(alert.textContent!.length).toBeLessThanOrEqual(320);
    expect(within(dialog).getByRole('button', { name: 'Transfer ownership' })).toBeEnabled();

    mocks.transferOwnership.mockRejectedValueOnce(new Error('Retry remains safely contained'));
    await user.click(within(dialog).getByRole('button', { name: 'Transfer ownership' }));
    await waitFor(() => expect(mocks.transferOwnership).toHaveBeenCalledTimes(2));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Retry remains safely contained');

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Transfer ownership to Alice?' })).not.toBeInTheDocument());
    await waitFor(() => expect(transferTrigger).toHaveFocus());
  });

  it('serializes pending approvals and denials across rows while retaining retry state', async () => {
    const user = userEvent.setup();
    const pendingApproval = deferred<{ success: boolean }>();
    mocks.approveRequest.mockReturnValueOnce(pendingApproval.promise);
    renderAdmin('/admin?tab=pending');

    const approveButtons = await screen.findAllByRole('button', { name: 'Approve' });
    const denyButtons = screen.getAllByRole('button', { name: 'Deny' });
    const usersTab = screen.getByRole('tab', { name: 'Users' });
    act(() => {
      approveButtons[0].click();
      approveButtons[0].click();
      approveButtons[1].click();
      denyButtons[1].click();
    });

    expect(mocks.approveRequest).toHaveBeenCalledTimes(1);
    expect(mocks.approveRequest).toHaveBeenCalledWith('request-a');
    expect(mocks.denyRequest).not.toHaveBeenCalled();
    await screen.findByRole('dialog', { name: 'Admin authority update in progress' });
    expect(approveButtons[0]).toHaveTextContent('Approving…');
    expect(approveButtons[0]).toHaveAttribute('aria-busy', 'true');
    expect(usersTab).toBeDisabled();

    await act(async () => {
      pendingApproval.reject({ response: { status: 409, data: { error: 'Approval service unavailable' } } });
      await pendingApproval.promise.catch(() => undefined);
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Approval service unavailable');
    expect(screen.getByText('new-a@example.com')).toBeVisible();
    mocks.approveRequest.mockResolvedValueOnce({ success: true });
    await user.click(screen.getAllByRole('button', { name: 'Approve' })[0]);
    await waitFor(() => expect(screen.queryByText('new-a@example.com')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Deny' }));
    await user.type(screen.getByRole('textbox', { name: 'Reason for denying new-b@example.com' }), 'Not verified');
    const pendingDenial = deferred<{ success: boolean }>();
    mocks.denyRequest.mockReturnValueOnce(pendingDenial.promise);
    const denyConfirm = screen.getByRole('button', { name: 'Confirm denial for new-b@example.com' });
    act(() => {
      denyConfirm.click();
      denyConfirm.click();
    });

    expect(mocks.denyRequest).toHaveBeenCalledTimes(1);
    expect(mocks.denyRequest).toHaveBeenCalledWith('request-b', 'Not verified');
    await screen.findByRole('dialog', { name: 'Admin authority update in progress' });
    expect(denyConfirm).toHaveTextContent('Denying…');
    expect(denyConfirm).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      pendingDenial.reject(new Error('Denial check failed'));
      await pendingDenial.promise.catch(() => undefined);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Denial check failed');
    expect(screen.getByRole('textbox', { name: 'Reason for denying new-b@example.com' })).toHaveValue('Not verified');

    mocks.denyRequest.mockResolvedValueOnce({ success: true });
    await user.click(screen.getByRole('button', { name: 'Confirm denial for new-b@example.com' }));
    await waitFor(() => expect(screen.queryByText('new-b@example.com')).not.toBeInTheDocument());
    expect(mocks.denyRequest).toHaveBeenCalledTimes(2);
  });

  it('reports a consistent sent approval notification as confirmed success', async () => {
    const status = await approveFirstPendingRequest({
      success: true,
      notification: {
        state: 'sent',
        delivered: true,
        manualNotificationRequired: false,
        reason: null,
      },
    });

    expect(status).toHaveTextContent('Registration approved for new-a@example.com.');
    expect(status).toHaveTextContent('The approval email was sent.');
    expect(status).toHaveClass('text-emerald-100');
    expect(status).not.toHaveTextContent(/contact the applicant directly/i);
  });

  it('reports private-mode manual notification as an approved account needing direct contact', async () => {
    const status = await approveFirstPendingRequest({
      success: true,
      notification: {
        state: 'manual_required',
        delivered: false,
        manualNotificationRequired: true,
        reason: '  Mail   requires a public domain.  ',
      },
    });

    expect(status).toHaveTextContent('Registration approved for new-a@example.com.');
    expect(status).toHaveTextContent('No approval email was sent; contact the applicant directly.');
    expect(status).toHaveTextContent('Mail requires a public domain.');
    expect(status).toHaveClass('text-amber-100');
    expect(status).not.toHaveTextContent(/failed to approve/i);
  });

  it('keeps a committed approval distinct from a failed delivery and bounds its reason', async () => {
    const status = await approveFirstPendingRequest({
      success: true,
      notification: {
        state: 'failed',
        delivered: false,
        manualNotificationRequired: true,
        reason: `\n Delivery\tprovider refused the message. ${'x'.repeat(500)}`,
      },
    });

    expect(status).toHaveTextContent('Registration approved for new-a@example.com, but the approval email could not be delivered.');
    expect(status).toHaveTextContent('Contact the applicant directly.');
    expect(status.textContent).not.toContain('\n');
    expect(status.textContent!.length).toBeLessThanOrEqual(400);
    expect(status).toHaveClass('text-amber-100');
    expect(status).not.toHaveTextContent(/failed to approve/i);
  });

  it('states explicitly when automatic approval notification is disabled', async () => {
    const status = await approveFirstPendingRequest({
      success: true,
      notification: {
        state: 'disabled',
        delivered: false,
        manualNotificationRequired: false,
        reason: 'Registration notifications are disabled.',
      },
    });

    expect(status).toHaveTextContent('Registration approved for new-a@example.com.');
    expect(status).toHaveTextContent('Automatic approval email is disabled; contact the applicant directly.');
    expect(status).toHaveClass('text-amber-100');
  });

  it.each([
    {
      label: 'a legacy response without notification metadata',
      response: { success: true },
    },
    {
      label: 'contradictory notification metadata',
      response: {
        success: true,
        notification: {
          state: 'sent' as const,
          delivered: false,
          manualNotificationRequired: false,
          reason: null,
        },
      },
    },
  ])('fails closed for $label without inviting a second approval', async ({ response }) => {
    const status = await approveFirstPendingRequest(response);

    expect(status).toHaveTextContent('Registration approved for new-a@example.com');
    expect(status).toHaveTextContent('Portal could not confirm the notification result.');
    expect(status).toHaveTextContent('Contact the applicant directly.');
    expect(status).toHaveTextContent('The approval is already complete; do not approve it again.');
    expect(status).toHaveClass('text-amber-100');
    expect(status).not.toHaveTextContent(/failed to approve/i);
  });

  it('keeps approval feedback visible after approving the final pending request', async () => {
    const status = await approveFirstPendingRequest({
      success: true,
      notification: {
        state: 'sent',
        delivered: true,
        manualNotificationRequired: false,
        reason: null,
      },
    }, [requestA]);

    expect(status).toHaveTextContent('The approval email was sent.');
    expect(screen.getByText('No pending registration requests')).toBeVisible();
  });

  it('reconciles a malformed success response before deciding an approval committed', async () => {
    mocks.listRegistrationRequests
      .mockResolvedValueOnce({ requests: [requestA, requestB], total: 2, page: 1, pages: 1 })
      .mockResolvedValueOnce({
        requests: [{ ...requestA, status: 'APPROVED' }, requestB],
        total: 2,
        page: 1,
        pages: 1,
      });
    mocks.approveRequest.mockResolvedValueOnce({ success: false });
    const user = userEvent.setup();
    renderAdmin('/admin?tab=pending');

    await user.click((await screen.findAllByRole('button', { name: 'Approve' }))[0]);

    await waitFor(() => expect(mocks.listRegistrationRequests).toHaveBeenCalledTimes(2));
    expect(mocks.listRegistrationRequests).toHaveBeenLastCalledWith({
      page: 1,
      limit: 100,
    });
    expect(screen.queryByText('new-a@example.com')).not.toBeInTheDocument();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Portal could not confirm the notification result.');
    expect(status).toHaveTextContent('do not approve it again');
    expect(status).toHaveClass('text-amber-100');
  });

  it('walks the bounded unfiltered registration pages to reconcile the exact request', async () => {
    const firstReconciliationPage = Array.from({ length: 100 }, (_, index): RegistrationRequest => ({
      ...requestB,
      id: `other-request-${index}`,
      email: `other-${index}@example.com`,
    }));
    mocks.listRegistrationRequests
      .mockResolvedValueOnce({ requests: [requestA, requestB], total: 2, page: 1, pages: 1 })
      .mockResolvedValueOnce({
        requests: firstReconciliationPage,
        total: 101,
        page: 1,
        pages: 2,
      })
      .mockResolvedValueOnce({
        requests: [{ ...requestA, status: 'APPROVED' }],
        total: 101,
        page: 2,
        pages: 2,
      });
    mocks.approveRequest.mockRejectedValueOnce(new Error('Approval response connection lost'));
    const user = userEvent.setup();
    renderAdmin('/admin?tab=pending');

    await user.click((await screen.findAllByRole('button', { name: 'Approve' }))[0]);

    await waitFor(() => expect(mocks.listRegistrationRequests).toHaveBeenCalledTimes(3));
    expect(mocks.listRegistrationRequests).toHaveBeenNthCalledWith(2, { page: 1, limit: 100 });
    expect(mocks.listRegistrationRequests).toHaveBeenNthCalledWith(3, { page: 2, limit: 100 });
    expect(screen.getByRole('status')).toHaveTextContent('Portal could not confirm the notification result.');
    expect(screen.queryByText('new-a@example.com')).not.toBeInTheDocument();
  });

  it('makes retry safe only after a lost response reconciles the request as still pending', async () => {
    mocks.listRegistrationRequests
      .mockResolvedValueOnce({ requests: [requestA, requestB], total: 2, page: 1, pages: 1 })
      .mockResolvedValueOnce({ requests: [requestA, requestB], total: 2, page: 1, pages: 1 });
    mocks.approveRequest.mockRejectedValueOnce({
      response: { status: 503, data: { error: 'Gateway response lost' } },
    });
    const user = userEvent.setup();
    renderAdmin('/admin?tab=pending');

    await user.click((await screen.findAllByRole('button', { name: 'Approve' }))[0]);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Portal confirmed that new-a@example.com is still pending.');
    expect(alert).toHaveTextContent('retrying is safe');
    expect(screen.getByText('new-a@example.com')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Approve' })[0]).toBeEnabled();
    expect(mocks.listRegistrationRequests).toHaveBeenCalledTimes(2);
  });

  it('blocks replay after an ambiguous failure until an authoritative refresh succeeds', async () => {
    mocks.listRegistrationRequests
      .mockResolvedValueOnce({ requests: [requestA, requestB], total: 2, page: 1, pages: 1 })
      .mockRejectedValueOnce(new Error('Refresh connection lost'));
    mocks.approveRequest.mockRejectedValueOnce(new Error('Approval response connection lost'));
    const user = userEvent.setup();
    renderAdmin('/admin?tab=pending');

    await user.click((await screen.findAllByRole('button', { name: 'Approve' }))[0]);

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Portal could not confirm whether the approval for new-a@example.com completed.');
    expect(status).toHaveTextContent('Do not approve this request again until the refresh succeeds.');
    const approve = screen.getAllByRole('button', { name: 'Approve' })[0];
    expect(approve).toBeDisabled();
    fireEvent.click(approve);
    expect(mocks.approveRequest).toHaveBeenCalledTimes(1);

    mocks.listRegistrationRequests.mockResolvedValueOnce({
      requests: [{ ...requestA, status: 'APPROVED' }, requestB],
      total: 2,
      page: 1,
      pages: 1,
    });
    await user.click(screen.getByRole('button', { name: 'Refresh pending requests' }));

    await waitFor(() => expect(screen.queryByText('new-a@example.com')).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('Portal could not confirm the notification result.');
    expect(screen.queryByRole('button', { name: 'Refresh pending requests' })).not.toBeInTheDocument();
    expect(mocks.approveRequest).toHaveBeenCalledTimes(1);
    expect(mocks.listRegistrationRequests).toHaveBeenCalledTimes(3);
  });

  it('does not misreport an approval when reconciliation finds the request denied', async () => {
    mocks.listRegistrationRequests
      .mockResolvedValueOnce({ requests: [requestA, requestB], total: 2, page: 1, pages: 1 })
      .mockResolvedValueOnce({
        requests: [{ ...requestA, status: 'DENIED' }, requestB],
        total: 2,
        page: 1,
        pages: 1,
      });
    mocks.approveRequest.mockRejectedValueOnce(new Error('Approval response connection lost'));
    const user = userEvent.setup();
    renderAdmin('/admin?tab=pending');

    await user.click((await screen.findAllByRole('button', { name: 'Approve' }))[0]);

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('was denied in another session');
    expect(status).toHaveTextContent('Approval did not complete');
    expect(status).not.toHaveTextContent('Registration approved');
    expect(screen.queryByText('new-a@example.com')).not.toBeInTheDocument();
    expect(mocks.approveRequest).toHaveBeenCalledTimes(1);
  });
});
