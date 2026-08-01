// @vitest-environment jsdom
import '../test/setup';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ResetPasswordPage from './ResetPasswordPage';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  refreshPublicSettings: vi.fn(),
  settings: {
    mail: {
      available: true,
      reason: null,
    },
  } as {
    mail: {
      available: boolean;
      reason: string | null;
    };
  } | null,
}));

vi.mock('../api/client', () => ({ default: { post: mocks.post } }));
vi.mock('../components/PublicAuthBrand', () => ({ default: () => <h1>Portal</h1> }));
vi.mock('../hooks/usePublicSettings', () => ({
  usePublicSettings: () => mocks.settings,
  refreshPublicSettings: mocks.refreshPublicSettings,
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

describe('password reset shell', () => {
  beforeEach(() => {
    mocks.post.mockReset();
    mocks.settings = {
      mail: {
        available: true,
        reason: null,
      },
    };
    mocks.refreshPublicSettings.mockReset().mockResolvedValue(mocks.settings);
    Object.defineProperty(window, 'scrollTo', { configurable: true, value: vi.fn() });
    window.history.replaceState({}, '', '/reset-password?token=reset-secret&from=email');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('scrubs the reset token from browser history and enforces the full password policy', async () => {
    render(<BrowserRouter><ResetPasswordPage /></BrowserRouter>);

    await waitFor(() => expect(window.location.search).toBe('?from=email'));
    await userEvent.type(screen.getByLabelText('New Password'), 'alllowercase');
    await userEvent.type(screen.getByLabelText('Confirm Password'), 'alllowercase');
    await userEvent.click(screen.getByRole('button', { name: 'Reset Password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('uppercase');
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('consumes newly issued fragment tokens without sending them in the page request URL', async () => {
    window.history.replaceState({}, '', '/reset-password#token=fragment-secret');
    mocks.post.mockResolvedValue({ data: { success: true } });

    render(<BrowserRouter><ResetPasswordPage /></BrowserRouter>);

    await waitFor(() => expect(window.location.hash).toBe(''));
    await userEvent.type(screen.getByLabelText('New Password'), 'ValidPassword1');
    await userEvent.type(screen.getByLabelText('Confirm Password'), 'ValidPassword1');
    await userEvent.click(screen.getByRole('button', { name: 'Reset Password' }));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/auth/reset-password', {
      token: 'fragment-secret',
      newPassword: 'ValidPassword1',
    }));
  });

  it('single-flights the one-time token, freezes its admitted password, and unlocks for retry', async () => {
    const pending = deferred<unknown>();
    mocks.post.mockReturnValueOnce(pending.promise);
    render(<BrowserRouter><ResetPasswordPage /></BrowserRouter>);
    await userEvent.type(screen.getByLabelText('New Password'), 'ValidPassword1');
    await userEvent.type(screen.getByLabelText('Confirm Password'), 'ValidPassword1');
    const form = screen.getByRole('button', { name: 'Reset Password' }).closest('form');

    fireEvent.submit(form!);
    fireEvent.submit(form!);
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'ChangedPassword2' } });

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith('/auth/reset-password', {
      token: 'reset-secret',
      newPassword: 'ValidPassword1',
    });
    expect(screen.getByLabelText('New Password')).toHaveValue('ValidPassword1');
    expect(screen.getByLabelText('New Password')).toBeDisabled();
    expect(screen.getByLabelText('Confirm Password')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Resetting password…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Show new password' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('aria-disabled', 'true');

    await act(async () => { pending.reject(new Error('temporary failure')); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reset Password' })).toBeEnabled());

    mocks.post.mockResolvedValueOnce({ data: { success: true } });
    await userEvent.click(screen.getByRole('button', { name: 'Reset Password' }));
    expect(await screen.findByRole('heading', { name: 'Password reset successfully' })).toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it('keeps an already-issued reset token usable when new recovery email is unavailable', async () => {
    mocks.settings = {
      mail: {
        available: false,
        reason: 'Mail requires a public domain.',
      },
    };
    mocks.post.mockResolvedValueOnce({ data: { success: true } });

    render(<BrowserRouter><ResetPasswordPage /></BrowserRouter>);

    expect(screen.getByLabelText('New Password')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('New Password'), 'ValidPassword1');
    await userEvent.type(screen.getByLabelText('Confirm Password'), 'ValidPassword1');
    await userEvent.click(screen.getByRole('button', { name: 'Reset Password' }));

    expect(await screen.findByRole('heading', { name: 'Password reset successfully' })).toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledWith('/auth/reset-password', {
      token: 'reset-secret',
      newPassword: 'ValidPassword1',
    });
  });

  it('turns a rejected token into neutral recovery guidance instead of promising another email', async () => {
    mocks.settings = {
      mail: {
        available: false,
        reason: 'Mail requires a public domain.',
      },
    };
    mocks.post.mockRejectedValueOnce({
      response: {
        status: 400,
        data: {
          error: 'Invalid or expired reset link. Please request a new password reset.',
        },
      },
    });

    render(<BrowserRouter><ResetPasswordPage /></BrowserRouter>);
    await userEvent.type(screen.getByLabelText('New Password'), 'ValidPassword1');
    await userEvent.type(screen.getByLabelText('Confirm Password'), 'ValidPassword1');
    await userEvent.click(screen.getByRole('button', { name: 'Reset Password' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This password reset link is invalid or expired.');
    expect(alert).not.toHaveTextContent('request a new password reset');
    expect(screen.getByRole('link', { name: 'Review password recovery options' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });

  it('does not promise another email when a token is missing and mail is unavailable', () => {
    window.history.replaceState({}, '', '/reset-password');
    mocks.settings = {
      mail: {
        available: false,
        reason: 'Mail requires a public domain.',
      },
    };

    render(<BrowserRouter><ResetPasswordPage /></BrowserRouter>);

    expect(screen.getByRole('heading', { name: 'Invalid Reset Link' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Mail requires a public domain.');
    expect(screen.getByText(/a new link cannot be emailed/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Request a new reset link' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toBeInTheDocument();
  });

  it('offers a new reset-link request only after mail availability is proven', () => {
    window.history.replaceState({}, '', '/reset-password');

    render(<BrowserRouter><ResetPasswordPage /></BrowserRouter>);

    expect(screen.getByRole('link', { name: 'Request a new reset link' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });

  it('fails closed and exits a hung capability check with a bounded retry state', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    window.history.replaceState({}, '', '/reset-password');
    mocks.settings = null;

    render(<BrowserRouter><ResetPasswordPage /></BrowserRouter>);

    expect(screen.getByRole('status')).toHaveTextContent(
      'Checking whether another reset link can be requested',
    );
    expect(screen.queryByRole('link', { name: 'Request a new reset link' })).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Portal could not verify whether reset email is available.',
    );
    expect(screen.getByRole('button', { name: 'Retry availability check' })).toBeEnabled();
  });
});
