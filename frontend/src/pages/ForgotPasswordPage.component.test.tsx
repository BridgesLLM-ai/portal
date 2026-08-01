// @vitest-environment jsdom
import '../test/setup';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ForgotPasswordPage from './ForgotPasswordPage';

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

describe('forgot-password submission ownership', () => {
  beforeEach(() => {
    mocks.post.mockReset();
    mocks.refreshPublicSettings.mockReset().mockResolvedValue(mocks.settings);
    mocks.settings = {
      mail: {
        available: true,
        reason: null,
      },
    };
    Object.defineProperty(window, 'scrollTo', { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('admits one snapshotted email request, blocks navigation, and unlocks for a retry', async () => {
    const pending = deferred<unknown>();
    mocks.post.mockReturnValueOnce(pending.promise);
    render(<MemoryRouter><ForgotPasswordPage /></MemoryRouter>);

    const email = screen.getByLabelText('Email');
    await userEvent.type(email, 'person@example.com');
    const form = screen.getByRole('button', { name: 'Send Reset Link' }).closest('form');
    fireEvent.submit(form!);
    fireEvent.submit(form!);
    fireEvent.change(email, { target: { value: 'changed@example.com' } });

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith('/auth/forgot-password', { email: 'person@example.com' });
    expect(email).toHaveValue('person@example.com');
    expect(email).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sending reset link…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('aria-disabled', 'true');

    await act(async () => { pending.reject(new Error('temporary failure')); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send Reset Link' })).toBeEnabled());

    mocks.post.mockResolvedValueOnce({ data: { ok: true } });
    await userEvent.click(screen.getByRole('button', { name: 'Send Reset Link' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
  });

  it('shows the backend capability reason and performs no recovery request when mail is unavailable', () => {
    mocks.settings = {
      mail: {
        available: false,
        reason: 'Mail requires a public domain.',
      },
    };

    render(<MemoryRouter><ForgotPasswordPage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Password recovery unavailable' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Mail requires a public domain.');
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send Reset Link' })).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('fails closed and exits the automatic checking state after a bounded wait', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.settings = null;

    render(<MemoryRouter><ForgotPasswordPage /></MemoryRouter>);

    expect(screen.getByRole('status')).toHaveTextContent('Checking password recovery');
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Recovery availability not verified');
    expect(screen.getByRole('button', { name: 'Retry availability check' })).toBeEnabled();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('single-flights a retry and reveals the form only after availability is proven', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = deferred<{
      mail: {
        available: boolean;
        reason: string | null;
      };
    } | null>();
    mocks.settings = null;
    mocks.refreshPublicSettings.mockReturnValue(pending.promise);

    render(<MemoryRouter><ForgotPasswordPage /></MemoryRouter>);

    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    vi.useRealTimers();
    const retry = screen.getByRole('button', { name: 'Retry availability check' });
    fireEvent.click(retry);
    fireEvent.click(retry);

    expect(mocks.refreshPublicSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Checking again…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();

    await act(async () => {
      pending.resolve({
        mail: {
          available: true,
          reason: null,
        },
      });
      await pending.promise;
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByLabelText('Email')).toBeInTheDocument());
  });
});
