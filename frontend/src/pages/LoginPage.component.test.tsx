// @vitest-environment jsdom
import '../test/setup';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from './LoginPage';

const testState = vi.hoisted(() => ({
  login: vi.fn(),
  signup: vi.fn(),
  completeTwoFactor: vi.fn(),
  recoverEmailTwoFactor: vi.fn(),
  cancelTwoFactor: vi.fn(),
  resendTwoFactorEmail: vi.fn(),
  auth: {
    twoFactorPending: false,
    twoFactorPendingToken: null as string | null,
    twoFactorMethod: null as 'totp' | 'email' | null,
    twoFactorEmailDelivery: null as {
      state: 'sent' | 'unavailable' | 'failed';
      message: string;
      recoveryAvailable?: boolean;
    } | null,
    isLoading: false,
    error: null as string | null,
  },
  settings: {
    portalName: 'Acme Portal',
    logoUrl: '/brand.png',
    registrationMode: 'closed' as 'open' | 'approval' | 'closed',
    mail: {
      available: true,
      reason: null as string | null,
    },
  },
}));

vi.mock('../hooks/usePublicSettings', () => ({
  usePublicSettings: () => testState.settings,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuthStore: () => ({
    login: testState.login,
    signup: testState.signup,
    completeTwoFactor: testState.completeTwoFactor,
    recoverEmailTwoFactor: testState.recoverEmailTwoFactor,
    cancelTwoFactor: testState.cancelTwoFactor,
    ...testState.auth,
    clearError: vi.fn(),
  }),
}));

vi.mock('../api/auth', () => ({
  authAPI: {
    twoFactorSendEmail: testState.resendTwoFactorEmail,
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('public login shell', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'scrollTo', { configurable: true, value: vi.fn() });
    testState.login.mockReset();
    testState.signup.mockReset();
    testState.completeTwoFactor.mockReset();
    testState.recoverEmailTwoFactor.mockReset();
    testState.cancelTwoFactor.mockReset();
    testState.resendTwoFactorEmail.mockReset();
    testState.auth = {
      twoFactorPending: false,
      twoFactorPendingToken: null,
      twoFactorMethod: null,
      twoFactorEmailDelivery: null,
      isLoading: false,
      error: null,
    };
    testState.settings = {
      portalName: 'Acme Portal',
      logoUrl: '/brand.png',
      registrationMode: 'closed',
      mail: {
        available: true,
        reason: null,
      },
    };
  });

  it('uses configured branding and fails closed when registration is closed', () => {
    render(<MemoryRouter><LoginPage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Acme Portal' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Acme Portal logo' })).toHaveAttribute('src', '/brand.png');
    expect(screen.queryByRole('button', { name: /sign up|request access/i })).not.toBeInTheDocument();
  });

  it('uses the bundled display mark when no custom logo is configured', () => {
    testState.settings.portalName = 'BridgesLLM';
    testState.settings.logoUrl = '';
    render(<MemoryRouter><LoginPage /></MemoryRouter>);

    expect(screen.getByRole('img', { name: 'BridgesLLM logo' }))
      .toHaveAttribute('src', '/logo-display.png');
  });

  it('labels approval-mode registration as an access request', async () => {
    testState.settings.registrationMode = 'approval';
    render(<MemoryRouter><LoginPage /></MemoryRouter>);

    await userEvent.click(screen.getByRole('button', { name: 'Request Access' }));

    expect(screen.getByRole('button', { name: 'Submit Access Request' })).toBeInTheDocument();
  });

  it('presents a pending access request as success and explains private-mode notification', async () => {
    testState.settings.registrationMode = 'approval';
    testState.settings.mail = {
      available: false,
      reason: 'Mail requires a public domain.',
    };
    testState.signup.mockResolvedValueOnce({
      pending: true,
      message: 'Your access request is waiting for administrator approval.',
    });
    render(<MemoryRouter><LoginPage /></MemoryRouter>);

    await userEvent.click(screen.getByRole('button', { name: 'Request Access' }));
    await userEvent.type(screen.getByLabelText('Email'), 'person@example.com');
    await userEvent.type(screen.getByLabelText('Username'), 'person');
    await userEvent.type(screen.getByLabelText('Password'), 'ValidPassword1');
    await userEvent.click(screen.getByRole('button', { name: 'Submit Access Request' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Your access request is waiting for administrator approval.');
    expect(status).toHaveTextContent(
      /email notifications are unavailable.*administrator may need to notify you directly/i,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('blocks weak registration passwords before submitting credentials', async () => {
    testState.settings.registrationMode = 'open';
    render(<MemoryRouter><LoginPage /></MemoryRouter>);

    await userEvent.click(screen.getByRole('button', { name: 'Sign Up' }));
    await userEvent.type(screen.getByLabelText('Email'), 'person@example.com');
    await userEvent.type(screen.getByLabelText('Username'), 'person');
    await userEvent.type(screen.getByLabelText('Password'), 'alllowercase');
    await userEvent.click(screen.getByRole('button', { name: 'Create Account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('uppercase');
    expect(testState.signup).not.toHaveBeenCalled();
  });

  it('admits one immutable login submission and blocks contradictory controls until it settles', async () => {
    const pending = deferred<{ requiresTwoFactor: boolean }>();
    testState.login.mockReturnValue(pending.promise);
    testState.settings.registrationMode = 'open';
    render(<MemoryRouter><LoginPage /></MemoryRouter>);

    const email = screen.getByLabelText('Email');
    const password = screen.getByLabelText('Password');
    await userEvent.type(email, 'person@example.com');
    await userEvent.type(password, 'original-password');
    const form = screen.getByRole('button', { name: 'Sign In' }).closest('form');
    expect(form).not.toBeNull();

    fireEvent.submit(form!);
    fireEvent.submit(form!);
    fireEvent.change(email, { target: { value: 'changed@example.com' } });

    expect(testState.login).toHaveBeenCalledTimes(1);
    expect(testState.login).toHaveBeenCalledWith('person@example.com', 'original-password');
    expect(email).toHaveValue('person@example.com');
    expect(email).toBeDisabled();
    expect(password).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Signing in…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Sign Up' })).toBeDisabled();

    await act(async () => { pending.reject(new Error('retry')); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign In' })).toBeEnabled());
  });

  it('shares the synchronous guard with account creation', async () => {
    const pending = deferred<{ pending: boolean }>();
    testState.signup.mockReturnValue(pending.promise);
    testState.settings.registrationMode = 'open';
    render(<MemoryRouter><LoginPage /></MemoryRouter>);

    await userEvent.click(screen.getByRole('button', { name: 'Sign Up' }));
    await userEvent.type(screen.getByLabelText('Email'), 'person@example.com');
    await userEvent.type(screen.getByLabelText('Username'), 'person');
    await userEvent.type(screen.getByLabelText('Password'), 'ValidPassword1');
    const form = screen.getByRole('button', { name: 'Create Account' }).closest('form');
    fireEvent.submit(form!);
    fireEvent.submit(form!);

    expect(testState.signup).toHaveBeenCalledTimes(1);
    expect(testState.signup).toHaveBeenCalledWith('person@example.com', 'person', 'ValidPassword1');
    expect(screen.getByRole('button', { name: 'Creating account…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeDisabled();
    await act(async () => { pending.reject(new Error('retry')); });
  });

  it('single-flights digit and paste verification paths and blocks challenge abandonment', async () => {
    const pending = deferred<void>();
    testState.completeTwoFactor.mockReturnValue(pending.promise);
    testState.auth.twoFactorPending = true;
    testState.auth.twoFactorMethod = 'totp';
    render(<MemoryRouter><LoginPage /></MemoryRouter>);

    const digits = Array.from({ length: 6 }, (_, index) => screen.getByLabelText(`Verification code digit ${index + 1} of 6`));
    ['1', '2', '3', '4', '5', '6'].forEach((digit, index) => {
      fireEvent.change(digits[index], { target: { value: digit } });
    });
    fireEvent.paste(screen.getByRole('group', { name: 'Six-digit authenticator verification code' }), {
      clipboardData: { getData: () => '654321' },
    });

    expect(testState.completeTwoFactor).toHaveBeenCalledTimes(1);
    expect(testState.completeTwoFactor).toHaveBeenCalledWith('123456');
    expect(screen.getByRole('status')).toHaveTextContent('Verifying…');
    expect(screen.getByRole('button', { name: 'Use a backup code instead' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back to sign in' })).toBeDisabled();
    digits.forEach((input) => expect(input).toBeDisabled());

    await act(async () => { pending.reject(new Error('invalid code')); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back to sign in' })).toBeEnabled());
  });

  it('single-flights a pasted verification code', async () => {
    const pending = deferred<void>();
    testState.completeTwoFactor.mockReturnValue(pending.promise);
    testState.auth.twoFactorPending = true;
    testState.auth.twoFactorMethod = 'totp';
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    const group = screen.getByRole('group', { name: 'Six-digit authenticator verification code' });

    fireEvent.paste(group, { clipboardData: { getData: () => '246810' } });
    fireEvent.paste(group, { clipboardData: { getData: () => '135790' } });

    expect(testState.completeTwoFactor).toHaveBeenCalledTimes(1);
    expect(testState.completeTwoFactor).toHaveBeenCalledWith('246810');
    await act(async () => { pending.reject(new Error('invalid code')); });
  });

  it('single-flights backup-code verification through the shared challenge guard', async () => {
    const pending = deferred<void>();
    testState.completeTwoFactor.mockReturnValue(pending.promise);
    testState.auth.twoFactorPending = true;
    testState.auth.twoFactorMethod = 'email';
    testState.auth.twoFactorPendingToken = 'pending-token';
    testState.auth.twoFactorEmailDelivery = {
      state: 'sent',
      message: 'A verification code was sent to your email address.',
    };
    render(<MemoryRouter><LoginPage /></MemoryRouter>);

    await userEvent.click(screen.getByRole('button', { name: 'Use a backup code instead' }));
    const backupInput = screen.getByLabelText('Backup code');
    await userEvent.type(backupInput, 'backup-code');
    const form = screen.getByRole('button', { name: 'Verify Backup Code' }).closest('form');
    fireEvent.submit(form!);
    fireEvent.submit(form!);

    expect(testState.completeTwoFactor).toHaveBeenCalledTimes(1);
    expect(testState.completeTwoFactor).toHaveBeenCalledWith('backup-code');
    expect(screen.getByRole('button', { name: 'Verifying…' })).toHaveAttribute('aria-busy', 'true');
    expect(backupInput).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use email code instead' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back to sign in' })).toBeDisabled();

    await act(async () => { pending.reject(new Error('invalid backup code')); });
  });

  it('owns email-code resend without presenting it as a verification turn', async () => {
    const pending = deferred<{ message: string }>();
    testState.resendTwoFactorEmail.mockReturnValue(pending.promise);
    testState.auth.twoFactorPending = true;
    testState.auth.twoFactorMethod = 'email';
    testState.auth.twoFactorPendingToken = 'pending-token';
    testState.auth.twoFactorEmailDelivery = {
      state: 'sent',
      message: 'A verification code was sent to your email address.',
    };
    render(<MemoryRouter><LoginPage /></MemoryRouter>);

    const resend = screen.getByRole('button', { name: 'Resend code' });
    fireEvent.click(resend);
    fireEvent.click(resend);

    expect(testState.resendTwoFactorEmail).toHaveBeenCalledTimes(1);
    expect(testState.resendTwoFactorEmail).toHaveBeenCalledWith('pending-token');
    expect(screen.getByRole('button', { name: 'Sending code…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).not.toHaveTextContent('Verifying…');
    expect(screen.getByRole('button', { name: 'Use a backup code instead' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back to sign in' })).toBeDisabled();

    await act(async () => { pending.resolve({ message: 'A new verification code was sent.' }); });
    await waitFor(() => expect(screen.getByRole('button', { name: /Resend code \(60s\)/ })).toBeDisabled());
  });

  it('keeps a failed email-code resend visible and retryable', async () => {
    testState.resendTwoFactorEmail
      .mockRejectedValueOnce({ response: { data: { error: 'Mail delivery is temporarily unavailable' } } })
      .mockResolvedValueOnce({ message: 'A new verification code was sent.' });
    testState.auth.twoFactorPending = true;
    testState.auth.twoFactorMethod = 'email';
    testState.auth.twoFactorPendingToken = 'pending-token';
    testState.auth.twoFactorEmailDelivery = {
      state: 'sent',
      message: 'A verification code was sent to your email address.',
    };
    render(<MemoryRouter><LoginPage /></MemoryRouter>);

    await userEvent.click(screen.getByRole('button', { name: 'Resend code' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Mail delivery is temporarily unavailable');
    expect(screen.getByRole('button', { name: 'Resend code' })).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: 'Resend code' }));

    expect(testState.resendTwoFactorEmail).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByRole('button', { name: /Resend code \(60s\)/ })).toBeDisabled());
  });

  it('shows email digits only when initial delivery is confirmed sent', () => {
    testState.auth.twoFactorPending = true;
    testState.auth.twoFactorMethod = 'email';
    testState.auth.twoFactorPendingToken = 'pending-token';
    testState.auth.twoFactorEmailDelivery = {
      state: 'sent',
      message: 'A verification code was sent to your email address.',
    };

    render(<MemoryRouter><LoginPage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByText('A verification code was sent to your email address.')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Six-digit email verification code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resend code' })).toBeEnabled();
  });

  it('fails closed to backup codes when email delivery is unavailable', () => {
    testState.auth.twoFactorPending = true;
    testState.auth.twoFactorMethod = 'email';
    testState.auth.twoFactorPendingToken = 'pending-token';
    testState.auth.twoFactorEmailDelivery = {
      state: 'unavailable',
      message: 'Mail requires a public domain.',
      recoveryAvailable: false,
    };

    render(<MemoryRouter><LoginPage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Use a backup code' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Mail requires a public domain.');
    expect(screen.getByLabelText('Backup code')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Six-digit email verification code' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /resend|try sending/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use email code instead' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /recover access/i })).not.toBeInTheDocument();
    expect(screen.getByText(/administrator must repair the account from the server console/i)).toBeInTheDocument();
    expect(screen.getByText(/if this is your last backup code/i)).toBeInTheDocument();
  });

  it('does not claim an email was sent when delivery metadata is missing', () => {
    testState.auth.twoFactorPending = true;
    testState.auth.twoFactorMethod = 'email';
    testState.auth.twoFactorPendingToken = 'pending-token';
    testState.auth.twoFactorEmailDelivery = null;

    render(<MemoryRouter><LoginPage /></MemoryRouter>);

    expect(screen.getByRole('status')).toHaveTextContent(/could not confirm whether a verification email was delivered/i);
    expect(screen.getByRole('status')).toHaveTextContent(/no email code is being assumed/i);
    expect(screen.getByLabelText('Backup code')).toBeInTheDocument();
    expect(screen.queryByText(/we sent a 6-digit code/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Six-digit email verification code' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try sending a code' })).toBeEnabled();
  });

  it('keeps a failed delivery on backup codes until a retry succeeds', async () => {
    testState.resendTwoFactorEmail.mockResolvedValue({
      message: 'A verification code was sent after retry.',
    });
    testState.auth.twoFactorPending = true;
    testState.auth.twoFactorMethod = 'email';
    testState.auth.twoFactorPendingToken = 'pending-token';
    testState.auth.twoFactorEmailDelivery = {
      state: 'failed',
      message: 'The verification email could not be delivered.',
    };

    render(<MemoryRouter><LoginPage /></MemoryRouter>);

    expect(screen.getByRole('alert')).toHaveTextContent('could not be delivered');
    expect(screen.getByLabelText('Backup code')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Six-digit email verification code' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Try sending a code' }));

    expect(testState.resendTwoFactorEmail).toHaveBeenCalledWith('pending-token');
    expect(await screen.findByRole('group', { name: 'Six-digit email verification code' })).toBeInTheDocument();
    expect(screen.getByText('A verification code was sent after retry.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Resend code \(60s\)/ })).toBeDisabled();
  });

  it('requires repeated password and the exact phrase for zero-backup recovery, then returns to fresh sign-in', async () => {
    testState.auth.twoFactorPending = true;
    testState.auth.twoFactorMethod = 'email';
    testState.auth.twoFactorPendingToken = 'pending-token';
    testState.auth.twoFactorEmailDelivery = {
      state: 'unavailable',
      message: 'Mail requires a public domain.',
      recoveryAvailable: true,
    };
    testState.recoverEmailTwoFactor.mockImplementation(async () => {
      testState.auth.twoFactorPending = false;
      testState.auth.twoFactorPendingToken = null;
      testState.auth.twoFactorMethod = null;
      testState.auth.twoFactorEmailDelivery = null;
      return {
        success: true,
        code: 'EMAIL_2FA_RECOVERED',
        requiresFreshLogin: true,
        message: 'Email Code 2FA was disabled. Sign in again, then enable Authenticator App 2FA.',
      };
    });

    render(<MemoryRouter><LoginPage /></MemoryRouter>);

    await userEvent.click(screen.getByRole('button', { name: /recover access/i }));
    const passwordInput = screen.getByLabelText('Enter your password again');
    const confirmationInput = screen.getByLabelText(`Type ${'DISABLE EMAIL 2FA'}`);
    const recoveryButton = screen.getByRole('button', { name: 'Disable Email Code 2FA' });

    await userEvent.type(passwordInput, 'CurrentPassword123!');
    await userEvent.type(confirmationInput, 'disable email 2fa');
    expect(recoveryButton).toBeDisabled();
    expect(testState.recoverEmailTwoFactor).not.toHaveBeenCalled();

    await userEvent.clear(confirmationInput);
    await userEvent.type(confirmationInput, 'DISABLE EMAIL 2FA');
    await userEvent.click(recoveryButton);

    expect(testState.recoverEmailTwoFactor).toHaveBeenCalledTimes(1);
    expect(testState.recoverEmailTwoFactor).toHaveBeenCalledWith(
      'CurrentPassword123!',
      'DISABLE EMAIL 2FA',
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      /email code 2fa was disabled.*sign in again.*authenticator app 2fa/i,
    );
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });
});
