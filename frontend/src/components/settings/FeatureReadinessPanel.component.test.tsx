// @vitest-environment jsdom
import '../../test/setup';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../contexts/AuthContext';
import FeatureReadinessPanel from './FeatureReadinessPanel';
import { SettingsMutationProvider } from './SettingsMutationContext';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  default: { get: mocks.get, post: mocks.post },
}));

const readiness = {
  ready: true,
  checkedAt: '2026-07-21T00:00:00.000Z',
  cached: false,
  refreshing: false,
  overall: 'partial',
  suggestedNextActions: [],
  features: [{
    id: 'remoteDesktop',
    label: 'Remote Desktop',
    status: 'missing',
    applicable: true,
    checks: [{
      id: 'desktop-runtime',
      label: 'Desktop runtime',
      type: 'command',
      required: true,
      ok: false,
      message: 'Runtime missing',
      remediation: 'Install the managed runtime',
    }],
    remediationAction: {
      id: 'setup-desktop',
      label: 'Set up Remote Desktop',
      endpoint: '/remote-desktop/auto-setup',
      method: 'POST',
      ownerOnly: true,
      confirmationPhrase: 'SET UP REMOTE DESKTOP',
      impact: 'Installs packages and restarts desktop services.',
    },
  }],
};

const readyReadiness = {
  ...readiness,
  checkedAt: '2026-07-21T00:01:00.000Z',
  overall: 'ready',
  features: readiness.features.map((feature) => ({
    ...feature,
    status: 'ready',
    checks: feature.checks.map((check) => ({ ...check, ok: true, message: 'Runtime ready' })),
  })),
};

const verifiedReadiness = {
  ...readyReadiness,
  checkedAt: '2026-07-21T00:02:00.000Z',
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

function SettingsOwnershipHarness({ children }: { children: ReactNode }) {
  const ownerRef = useRef<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const claim = useCallback((nextOwner: string) => {
    if (ownerRef.current) return false;
    ownerRef.current = nextOwner;
    setOwner(nextOwner);
    return true;
  }, []);
  const release = useCallback((nextOwner: string) => {
    if (ownerRef.current !== nextOwner) return;
    ownerRef.current = null;
    setOwner(null);
  }, []);
  const value = useMemo(() => ({ owner, claim, release }), [claim, owner, release]);
  return (
    <SettingsMutationProvider value={value}>
      <button type="button" disabled={Boolean(owner)}>Leave Settings</button>
      {children}
    </SettingsMutationProvider>
  );
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <SettingsOwnershipHarness>
        <FeatureReadinessPanel />
      </SettingsOwnershipHarness>
    </MemoryRouter>,
  );
}

async function openAndConfirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Set up Remote Desktop' }));
  const dialog = screen.getByRole('dialog', { name: 'Set up Remote Desktop' });
  await user.type(
    within(dialog).getByRole('textbox', { name: /Type SET UP REMOTE DESKTOP to continue/i }),
    'SET UP REMOTE DESKTOP',
  );
  await user.click(within(dialog).getByRole('button', { name: 'Run owner setup' }));
  return dialog;
}

describe('FeatureReadinessPanel owner setup admission', () => {
  beforeEach(() => {
    mocks.get.mockReset().mockResolvedValue({ data: readiness });
    mocks.post.mockReset();
    useAuthStore.setState({
      user: {
        id: 'owner-1',
        email: 'owner@example.com',
        username: 'owner',
        role: 'OWNER',
        accountStatus: 'ACTIVE',
      },
      isAuthenticated: true,
      isLoading: false,
      sessionRestoreError: false,
    });
  });

  afterEach(() => {
    useAuthStore.setState({ user: null, isAuthenticated: false });
  });

  it('single-flights owner setup and keeps failure and progress in the confirmation owner', async () => {
    const user = userEvent.setup();
    const firstAttempt = deferred<unknown>();
    mocks.post.mockReturnValueOnce(firstAttempt.promise);
    mocks.get
      .mockReset()
      .mockResolvedValueOnce({ data: readiness })
      .mockResolvedValueOnce({ data: readyReadiness });

    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Set up Remote Desktop' }));
    const dialog = screen.getByRole('dialog', { name: 'Set up Remote Desktop' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /Type SET UP REMOTE DESKTOP to continue/i }),
      'SET UP REMOTE DESKTOP',
    );
    const confirm = within(dialog).getByRole('button', { name: 'Run owner setup' });

    act(() => {
      confirm.click();
      confirm.click();
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith('/remote-desktop/auto-setup', {
      confirmation: 'SET UP REMOTE DESKTOP',
    });
    expect(await within(dialog).findByRole('button', { name: 'Running owner setup…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Leave Settings').closest('button')).toBeDisabled();
    expect(screen.getByRole('dialog', { name: 'Set up Remote Desktop' })).toBeVisible();

    await act(async () => {
      firstAttempt.reject({ response: { data: { error: 'Host setup was refused' } } });
      await firstAttempt.promise.catch(() => undefined);
    });

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Host setup was refused');
    expect(within(dialog).getByRole('button', { name: 'Run owner setup' })).toBeEnabled();
    expect(screen.getByText('Leave Settings').closest('button')).toBeEnabled();

    mocks.post.mockResolvedValueOnce({
      data: { ok: true, steps: [], message: 'Remote Desktop is ready.' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Run owner setup' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Set up Remote Desktop' })).not.toBeInTheDocument());
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it.each(['missing', 'partial', 'not_configured'] as const)(
    'retains accepted setup when the exact target is %s and retries verification without another POST',
    async (targetStatus) => {
      const user = userEvent.setup();
      const unverified = {
        ...readyReadiness,
        features: readyReadiness.features.map((feature) => ({ ...feature, status: targetStatus })),
      };
      mocks.get
        .mockReset()
        .mockResolvedValueOnce({ data: readiness })
        .mockResolvedValueOnce({ data: unverified })
        .mockResolvedValueOnce({ data: verifiedReadiness });
      mocks.post.mockResolvedValue({
        data: { ok: true, steps: [], message: 'Host setup accepted.' },
      });

      renderPanel();
      const dialog = await openAndConfirm(user);

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(`target feature still reports ${targetStatus === 'not_configured' ? 'Optional · not configured' : targetStatus}`);
      expect(within(dialog).getByRole('button', { name: 'Retry verification' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Verify Remote Desktop', hidden: true })).toBeVisible();
      expect(mocks.post).toHaveBeenCalledTimes(1);

      await user.click(within(dialog).getByRole('button', { name: 'Retry verification' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Set up Remote Desktop' })).not.toBeInTheDocument());
      expect(mocks.post).toHaveBeenCalledTimes(1);
      expect(mocks.get).toHaveBeenLastCalledWith('/system/readiness', expect.objectContaining({
        params: { refresh: true },
        timeout: expect.any(Number),
      }));
    },
  );

  it('keeps the dialog owner while a forced refresh advances beyond a stale cached snapshot', async () => {
    const user = userEvent.setup();
    const converged = deferred<{ data: typeof readyReadiness }>();
    mocks.get
      .mockReset()
      .mockResolvedValueOnce({ data: readiness })
      .mockResolvedValueOnce({ data: { ...readiness, cached: true, refreshing: true } })
      .mockReturnValueOnce(converged.promise);
    mocks.post.mockResolvedValue({ data: { ok: true, steps: [], message: 'Host setup accepted.' } });

    renderPanel();
    const dialog = await openAndConfirm(user);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(3));
    const readinessCalls = mocks.get.mock.calls.filter(([path]) => path === '/system/readiness');
    expect(readinessCalls.filter(([, options]) => options?.params?.refresh === true)).toHaveLength(1);
    expect(readinessCalls[2]?.[1]).toEqual(expect.objectContaining({ timeout: expect.any(Number) }));
    expect(readinessCalls[2]?.[1]).not.toHaveProperty('params');
    expect(within(dialog).getByRole('button', { name: 'Verifying readiness…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('dialog', { name: 'Set up Remote Desktop' })).toBeVisible();
    expect(mocks.post).toHaveBeenCalledTimes(1);

    await act(async () => {
      converged.resolve({ data: readyReadiness });
      await converged.promise;
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Set up Remote Desktop' })).not.toBeInTheDocument());
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it('retains an accepted setup across readback failure and retries only the forced GET', async () => {
    const user = userEvent.setup();
    mocks.get
      .mockReset()
      .mockResolvedValueOnce({ data: readiness })
      .mockRejectedValueOnce(new Error('Readiness service unavailable'))
      .mockResolvedValueOnce({ data: readyReadiness });
    mocks.post.mockResolvedValue({ data: { ok: true, steps: [], message: 'Host setup accepted.' } });

    renderPanel();
    const dialog = await openAndConfirm(user);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('could not obtain a fresh readiness response');
    expect(mocks.post).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole('button', { name: 'Retry verification' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Set up Remote Desktop' })).not.toBeInTheDocument());
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it('never treats an accepted ok:false result as ready or resubmits it', async () => {
    const user = userEvent.setup();
    mocks.get
      .mockReset()
      .mockResolvedValueOnce({ data: readiness })
      .mockResolvedValueOnce({ data: readyReadiness })
      .mockResolvedValue({ data: verifiedReadiness });
    mocks.post.mockResolvedValue({
      data: { ok: false, steps: [{ step: 'install', ok: false, message: 'Package install failed' }], message: 'Setup was incomplete.' },
    });

    renderPanel();
    const dialog = await openAndConfirm(user);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('did not complete successfully');
    expect(within(dialog).getByRole('button', { name: 'Retry verification' })).toBeEnabled();
    expect(mocks.post).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole('button', { name: 'Retry verification' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('did not complete successfully');
    expect(screen.getByRole('dialog', { name: 'Set up Remote Desktop' })).toBeVisible();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(3);
  });
});
