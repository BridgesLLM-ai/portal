// @vitest-environment jsdom
import '../test/setup';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DashboardPage from './DashboardPage';

const mocks = vi.hoisted(() => ({
  metricsLatest: vi.fn(async () => null),
  metricsHistory: vi.fn(async () => []),
  systemStatsLatest: vi.fn(async () => null),
  alertsList: vi.fn(async () => ({ alerts: [] })),
  clientGet: vi.fn(),
  clientPost: vi.fn(),
  waitForExpectedPortalVersion: vi.fn(),
  shellAction: vi.fn(),
  io: vi.fn((_url: string) => ({ on: vi.fn(), disconnect: vi.fn() })),
  authUser: { current: { id: 'user-1', role: 'USER', email: 'user@example.com' } as any },
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuthStore: (selector: (state: any) => unknown) => selector({
    user: mocks.authUser.current,
  }),
}));

vi.mock('../api/endpoints', () => ({
  metricsAPI: { latest: mocks.metricsLatest, history: mocks.metricsHistory },
  systemStatsAPI: { latest: mocks.systemStatsLatest },
  alertsAPI: { list: mocks.alertsList, dismiss: vi.fn() },
}));

vi.mock('../api/client', () => ({
  default: { get: mocks.clientGet, post: mocks.clientPost },
}));

vi.mock('../utils/updatePreparation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/updatePreparation')>();
  return {
    ...actual,
    waitForExpectedPortalVersion: mocks.waitForExpectedPortalVersion,
  };
});

vi.mock('./settingsAdminContract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./settingsAdminContract')>();
  return {
    ...actual,
    maintenancePollDelayMs: vi.fn(() => 10),
  };
});

vi.mock('socket.io-client', () => ({ io: mocks.io }));
vi.mock('../components/ActivityLogTable', () => ({ default: () => <div>Personal activity</div> }));
vi.mock('../components/dashboard/DashboardCharts', () => ({ default: () => <div>Charts</div> }));

const verifiedUpdate = {
  current: '4.0.0',
  latest: '4.1.0',
  updateAvailable: true,
  detailsStatus: 'verified',
  details: {
    version: '4.1.0',
    releasedAt: '2026-07-20',
    releaseClass: 'feature',
    highlights: [
      'Project Chat now supports qualified provider lanes.',
      'Update details are verified before display.',
    ],
    provenance: 'signed-release-manifest',
  },
};

const staleBackupUpdate = {
  ...verifiedUpdate,
  preparation: {
    confirmationPhrase: 'UPDATE PORTAL',
    backup: {
      state: 'stale',
      maxAgeHours: 24,
      newestCreatedAt: '2026-07-17T20:00:00.000Z',
      ageHours: 72,
      activeStatus: null,
    },
  },
};

const coldMaintenanceStatus = {
  ready: false,
  cached: false,
  refreshing: true,
  checkedAt: null,
  status: 'info',
  summary: 'Server checks are running in the background.',
  issues: [],
  actions: [],
};

const readyMaintenanceStatus = {
  ready: true,
  cached: true,
  refreshing: false,
  checkedAt: '2026-07-20T12:00:00.000Z',
  status: 'healthy',
  summary: 'Healthy',
  host: { hostname: 'test', os: 'Linux', kernel: '6.8.0', uptimeSeconds: 1 },
  issues: [],
  actions: [],
};

const connectedGatewayBase = {
  connected: true,
  wsConnected: true,
  chatReady: true,
  gatewayReachable: true,
  modelsConfigured: true,
  modelCount: 20,
};

const lightweightGatewayHealth = {
  ...connectedGatewayBase,
  ok: true,
  issues: [],
  openclawVersion: {
    runningVersion: null,
    mismatch: false,
    restartRecommended: false,
    reason: 'OpenClaw version probe scheduled.',
    probeOk: true,
    lightweight: true,
  },
};

const transientGatewayHealth = {
  ...connectedGatewayBase,
  ok: false,
  issues: ['OpenClaw gateway runtime unknown does not match tested runtime 2026.7.1.'],
  openclawVersion: {
    runningVersion: null,
    mismatch: false,
    restartRecommended: false,
    reason: null,
    probeOk: false,
    lightweight: false,
  },
};

const healthyGatewayHealth = {
  ...connectedGatewayBase,
  ok: true,
  issues: [],
  openclawVersion: {
    runningVersion: '2026.7.1-2',
    mismatch: false,
    restartRecommended: false,
    reason: null,
    probeOk: true,
    lightweight: false,
  },
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

function DashboardUpdateHarness() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <button type="button" onClick={mocks.shellAction}>Logout shell action</button>
      <button type="button" onClick={() => navigate('/settings')}>Leave Dashboard</button>
      <output aria-label="Current route">{location.pathname}</output>
      <DashboardPage />
    </>
  );
}

function mockOwnerGatewayChecks(resolveGateway: (url: string) => unknown | Promise<unknown>) {
  mocks.authUser.current = { id: 'owner-1', role: 'OWNER', email: 'owner@example.com' };
  mocks.clientPost.mockResolvedValue({ data: { ...verifiedUpdate, updateAvailable: false } });
  mocks.clientGet.mockImplementation(async (url: string) => {
    if (url.startsWith('/gateway/health')) return resolveGateway(url);
    if (url === '/system/maintenance') return { data: readyMaintenanceStatus };
    return { data: null };
  });
}

function mockOwnerBackgroundChecks(update: any) {
  mocks.authUser.current = { id: 'owner-1', role: 'OWNER', email: 'owner@example.com' };
  mocks.clientPost.mockImplementation(async (url: string) => {
    if (url === '/admin/check-updates') return { data: update };
    return { data: {} };
  });
  mocks.clientGet.mockImplementation(async (url: string) => {
    if (url.startsWith('/gateway/health')) {
      return { data: { ok: true, openclawVersion: { restartRecommended: false } } };
    }
    if (url === '/system/maintenance') {
      return {
        data: {
          checkedAt: '2026-07-20T00:00:00.000Z',
          status: 'healthy',
          summary: 'Healthy',
          host: { hostname: 'test', os: 'Linux', kernel: 'test', uptimeSeconds: 1 },
          issues: [],
          actions: [],
        },
      };
    }
    return { data: null };
  });
}

describe('dashboard role-aware loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clientGet.mockReset();
    mocks.clientPost.mockReset();
    mocks.waitForExpectedPortalVersion.mockReset().mockResolvedValue(false);
    mocks.shellAction.mockReset();
    mocks.authUser.current = { id: 'user-1', role: 'USER', email: 'user@example.com' };
  });

  it('does not request operator-only diagnostics for a regular user', async () => {
    render(<DashboardPage />);

    await waitFor(() => expect(mocks.metricsLatest).toHaveBeenCalled());
    expect(mocks.metricsHistory).toHaveBeenCalledWith(6);
    expect(mocks.systemStatsLatest).not.toHaveBeenCalled();
    expect(mocks.alertsList).not.toHaveBeenCalled();
    expect(mocks.clientGet).not.toHaveBeenCalled();
    expect(mocks.clientPost).not.toHaveBeenCalled();
    expect(mocks.io).toHaveBeenCalledTimes(1);
    expect(String(mocks.io.mock.calls[0][0])).toMatch(/\/metrics$/);
  });

  it('retries a connected transient OpenClaw version failure and stops on the exact healthy pair', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let view: ReturnType<typeof render> | undefined;
    let forcedCalls = 0;
    try {
      mockOwnerGatewayChecks((url) => {
        if (url === '/gateway/health?cooldown=1') return { data: lightweightGatewayHealth };
        forcedCalls += 1;
        return { data: forcedCalls === 1 ? transientGatewayHealth : healthyGatewayHealth };
      });
      view = render(<DashboardPage />);

      await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
      expect(screen.getByText('OpenClaw Connected')).toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(1_600); });
      expect(screen.getByText('OpenClaw Offline')).toBeInTheDocument();
      expect(screen.getByText(/gateway runtime unknown/i)).toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(3_200); });
      expect(screen.getByText('OpenClaw Connected')).toBeInTheDocument();
      expect(screen.queryByText(/gateway runtime unknown/i)).not.toBeInTheDocument();

      const gatewayCalls = mocks.clientGet.mock.calls.filter(([url]) => String(url).startsWith('/gateway/health'));
      expect(gatewayCalls.map(([url]) => url)).toEqual([
        '/gateway/health?cooldown=1',
        '/gateway/health?forceVersion=1',
        '/gateway/health?forceVersion=1',
      ]);
      expect(forcedCalls).toBe(2);
      expect(gatewayCalls.every(([, config]) => config?._silent === true)).toBe(true);
    } finally {
      view?.unmount();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('retries a rejected forced health request and stops on the next healthy response', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let view: ReturnType<typeof render> | undefined;
    let forcedCalls = 0;
    try {
      mockOwnerGatewayChecks((url) => {
        if (url === '/gateway/health?cooldown=1') return { data: lightweightGatewayHealth };
        forcedCalls += 1;
        if (forcedCalls === 1) return Promise.reject(new Error('temporary health request failure'));
        return { data: healthyGatewayHealth };
      });
      view = render(<DashboardPage />);

      await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_600); });
      expect(screen.getByText('OpenClaw Connected')).toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(3_200); });
      expect(screen.getByText('OpenClaw Connected')).toBeInTheDocument();

      const gatewayCalls = mocks.clientGet.mock.calls.filter(([url]) => String(url).startsWith('/gateway/health'));
      expect(gatewayCalls.map(([url]) => url)).toEqual([
        '/gateway/health?cooldown=1',
        '/gateway/health?forceVersion=1',
        '/gateway/health?forceVersion=1',
      ]);
      expect(forcedCalls).toBe(2);
      expect(gatewayCalls.every(([, config]) => config?._silent === true)).toBe(true);
    } finally {
      view?.unmount();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('caps a permanently transient connected OpenClaw version probe at three forced attempts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let view: ReturnType<typeof render> | undefined;
    try {
      mockOwnerGatewayChecks((url) => ({
        data: url === '/gateway/health?cooldown=1' ? lightweightGatewayHealth : transientGatewayHealth,
      }));
      view = render(<DashboardPage />);

      await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_600); });
      await act(async () => { await vi.advanceTimersByTimeAsync(3_200); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

      const gatewayCalls = mocks.clientGet.mock.calls.filter(([url]) => String(url).startsWith('/gateway/health'));
      expect(gatewayCalls.map(([url]) => url)).toEqual([
        '/gateway/health?cooldown=1',
        '/gateway/health?forceVersion=1',
        '/gateway/health?forceVersion=1',
        '/gateway/health?forceVersion=1',
      ]);
      expect(gatewayCalls.every(([, config]) => config?._silent === true)).toBe(true);
      expect(screen.getByText('OpenClaw Offline')).toBeInTheDocument();
      expect(screen.getByText(/gateway runtime unknown/i)).toBeInTheDocument();
    } finally {
      view?.unmount();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    ['a real version mismatch', {
      ...connectedGatewayBase,
      ok: false,
      issues: ['OpenClaw gateway is running an older version.'],
      openclawVersion: {
        runningVersion: '2026.6.3',
        mismatch: true,
        restartRecommended: true,
        reason: 'OpenClaw gateway is running an older version.',
        probeOk: true,
        lightweight: false,
      },
    }],
    ['a true gateway disconnection', {
      ok: false,
      connected: false,
      wsConnected: false,
      chatReady: false,
      gatewayReachable: false,
      modelsConfigured: false,
      modelCount: 0,
      issues: ['Cannot reach OpenClaw gateway.'],
      openclawVersion: {
        runningVersion: null,
        mismatch: false,
        restartRecommended: false,
        reason: 'OpenClaw version probe scheduled.',
        probeOk: false,
        lightweight: true,
      },
    }],
  ])('does not retry %s', async (_label, gatewayHealth) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let view: ReturnType<typeof render> | undefined;
    try {
      mockOwnerGatewayChecks(() => ({ data: gatewayHealth }));
      view = render(<DashboardPage />);

      await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

      const gatewayCalls = mocks.clientGet.mock.calls.filter(([url]) => String(url).startsWith('/gateway/health'));
      expect(gatewayCalls.map(([url]) => url)).toEqual(['/gateway/health?cooldown=1']);
      expect(gatewayCalls[0][1]).toMatchObject({ _silent: true });
    } finally {
      view?.unmount();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('does not apply or reschedule an in-flight forced probe after unmount', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let resolveForcedProbe!: (value: { data: typeof transientGatewayHealth }) => void;
    const forcedProbe = new Promise<{ data: typeof transientGatewayHealth }>((resolve) => {
      resolveForcedProbe = resolve;
    });
    let forcedCalls = 0;
    try {
      mockOwnerGatewayChecks((url) => {
        if (url === '/gateway/health?cooldown=1') return { data: lightweightGatewayHealth };
        forcedCalls += 1;
        return forcedProbe;
      });
      const view = render(<DashboardPage />);

      await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_600); });
      expect(forcedCalls).toBe(1);

      view.unmount();
      resolveForcedProbe({ data: transientGatewayHealth });
      await act(async () => {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(forcedCalls).toBe(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('admits only one gateway restart before the busy state can render', async () => {
    const restart = deferred<{ data: { ok: boolean; openclawVersion: { restartRecommended: boolean } } }>();
    mocks.authUser.current = { id: 'owner-1', role: 'OWNER', email: 'owner@example.com' };
    mocks.clientPost.mockImplementation((url: string) => {
      if (url === '/admin/check-updates') {
        return Promise.resolve({ data: { ...verifiedUpdate, updateAvailable: false } });
      }
      if (url === '/gateway/restart') return restart.promise;
      return Promise.resolve({ data: {} });
    });
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/gateway/health')) {
        return {
          data: {
            ...connectedGatewayBase,
            ok: false,
            issues: ['Gateway restart required.'],
            openclawVersion: {
              ...healthyGatewayHealth.openclawVersion,
              restartRecommended: true,
              reason: 'Gateway restart required.',
            },
          },
        };
      }
      if (url === '/system/maintenance') return { data: readyMaintenanceStatus };
      return { data: null };
    });

    render(<DashboardPage />);
    const restartButton = await screen.findByRole('button', { name: 'Restart OpenClaw' }, { timeout: 3000 });
    act(() => {
      restartButton.click();
      restartButton.click();
    });

    expect(mocks.clientPost.mock.calls.filter(([url]) => url === '/gateway/restart')).toHaveLength(1);
    expect(await screen.findByRole('button', { name: 'Restarting…' })).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      restart.resolve({ data: { ok: true, openclawVersion: { restartRecommended: false } } });
      await restart.promise;
    });
  });

  it('admits only one gateway reconnect before the busy state can render', async () => {
    const reconnect = deferred<{ data: { ok: boolean } }>();
    mocks.authUser.current = { id: 'owner-1', role: 'OWNER', email: 'owner@example.com' };
    mocks.clientPost.mockImplementation((url: string) => {
      if (url === '/admin/check-updates') {
        return Promise.resolve({ data: { ...verifiedUpdate, updateAvailable: false } });
      }
      if (url === '/gateway/reconnect') return reconnect.promise;
      return Promise.resolve({ data: {} });
    });
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/gateway/health')) {
        return {
          data: {
            ok: false,
            connected: false,
            wsConnected: false,
            chatReady: false,
            gatewayReachable: false,
            modelsConfigured: false,
            modelCount: 0,
            issues: ['Gateway is offline.'],
            openclawVersion: {
              ...healthyGatewayHealth.openclawVersion,
              runningVersion: null,
              restartRecommended: false,
              probeOk: false,
            },
          },
        };
      }
      if (url === '/system/maintenance') return { data: readyMaintenanceStatus };
      return { data: null };
    });

    render(<DashboardPage />);
    const reconnectButton = await screen.findByRole('button', { name: 'Reconnect' }, { timeout: 3000 });
    act(() => {
      reconnectButton.click();
      reconnectButton.click();
    });

    expect(mocks.clientPost.mock.calls.filter(([url]) => url === '/gateway/reconnect')).toHaveLength(1);
    expect(await screen.findByRole('button', { name: 'Reconnecting…' })).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      reconnect.resolve({ data: { ok: true } });
      await reconnect.promise;
    });
  });

  it('keeps the update card compact and expands verified release highlights on request', async () => {
    mockOwnerBackgroundChecks(verifiedUpdate);
    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText('Update available: v4.1.0 (you have v4.0.0)')).toBeInTheDocument();
    }, { timeout: 3000 });

    expect(screen.getByText('Feature drop')).toBeInTheDocument();
    expect(screen.queryByText('Project Chat now supports qualified provider lanes.')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'View details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).not.toHaveAttribute('aria-controls');
    fireEvent.click(toggle);

    const expandedToggle = screen.getByRole('button', { name: 'Hide details' });
    expect(expandedToggle).toHaveAttribute('aria-expanded', 'true');
    expect(expandedToggle).toHaveAttribute('aria-controls', 'dashboard-update-details');
    expect(screen.getByRole('region', { name: 'Hide details' })).toHaveAttribute('id', 'dashboard-update-details');
    expect(screen.getByText('Feature drop release')).toBeInTheDocument();
    expect(screen.getByText(/Released .*2026/)).toBeInTheDocument();
    expect(screen.getByText('Verified signed release metadata')).toBeInTheDocument();
    expect(screen.getByText('Project Chat now supports qualified provider lanes.')).toBeInTheDocument();
    expect(screen.getByText('Update details are verified before display.')).toBeInTheDocument();
  });

  it('warns about a stale backup and requires an explicit recovery plan before updating', async () => {
    mocks.authUser.current = { id: 'owner-1', role: 'OWNER', email: 'owner@example.com' };
    mocks.clientPost.mockImplementation(async (url: string, body?: unknown) => {
      if (url === '/admin/check-updates') return { data: staleBackupUpdate };
      if (url === '/admin/self-update') {
        throw Object.assign(new Error('Stop after admission request'), {
          response: { data: { error: 'Updater intentionally not started in this test', body } },
        });
      }
      return { data: {} };
    });
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/gateway/health')) {
        return { data: { ok: true, openclawVersion: { restartRecommended: false } } };
      }
      if (url === '/system/maintenance') return { data: readyMaintenanceStatus };
      return { data: null };
    });
    render(<DashboardPage />);

    await waitFor(() => expect(screen.getByText('Backup is stale')).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText(/latest Portal backup is 3 days old/i)).toBeInTheDocument();
    const reviewButton = screen.getByRole('button', { name: 'Review & update' });
    fireEvent.click(reviewButton);

    expect(screen.getByRole('dialog', { name: 'Install Portal v4.1.0' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Create a fresh backup, then update' })).toBeChecked();
    expect(screen.getByText('Project Chat now supports qualified provider lanes.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Continue without a fresh backup' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Type UPDATE PORTAL to continue/i }), {
      target: { value: 'UPDATE PORTAL' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update without backup' }));

    await waitFor(() => {
      expect(mocks.clientPost).toHaveBeenCalledWith('/admin/self-update', {
        confirmation: 'UPDATE PORTAL',
        backupDecision: 'proceed-without-fresh',
        expectedVersion: '4.1.0',
      });
    });
    expect(mocks.clientPost.mock.calls.some(([url]) => url === '/backups/create')).toBe(false);
    expect(await screen.findByText('Updater intentionally not started in this test')).toBeInTheDocument();
  });

  it('keeps the signed updater submission single-flight while the server accepts it', async () => {
    mocks.authUser.current = { id: 'owner-1', role: 'OWNER', email: 'owner@example.com' };
    let rejectUpdate!: (reason: Error) => void;
    const pendingUpdate = new Promise((_resolve, reject) => {
      rejectUpdate = reject;
    });
    mocks.clientPost.mockImplementation(async (url: string) => {
      if (url === '/admin/check-updates') return { data: staleBackupUpdate };
      if (url === '/admin/self-update') return pendingUpdate;
      return { data: {} };
    });
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/gateway/health')) {
        return { data: { ok: true, openclawVersion: { restartRecommended: false } } };
      }
      if (url === '/system/maintenance') return { data: readyMaintenanceStatus };
      return { data: null };
    });

    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText('Backup is stale')).toBeInTheDocument(), { timeout: 3000 });
    const reviewButton = screen.getByRole('button', { name: 'Review & update' });
    fireEvent.click(reviewButton);
    fireEvent.click(screen.getByRole('radio', { name: 'Continue without a fresh backup' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Type UPDATE PORTAL to continue/i }), {
      target: { value: 'UPDATE PORTAL' },
    });

    const startButton = screen.getByRole('button', { name: 'Update without backup' });
    fireEvent.click(startButton);
    fireEvent.click(startButton);

    await waitFor(() => {
      expect(mocks.clientPost.mock.calls.filter(([url]) => url === '/admin/self-update')).toHaveLength(1);
    });
    expect(screen.getByRole('button', { name: 'Starting signed updater…' })).toBeDisabled();

    rejectUpdate(Object.assign(new Error('Updater admission test complete'), {
      response: {
        data: {
          code: 'PORTAL_UPDATE_LAUNCH_FAILED',
          error: 'Updater admission test complete',
        },
      },
    }));
    expect(await screen.findByText('Updater admission test complete')).toBeInTheDocument();
  });

  it('retains update ownership after a lost admission response until canonical version proof settles', async () => {
    const lostResponseReadback = deferred<boolean>();
    mocks.authUser.current = { id: 'owner-1', role: 'OWNER', email: 'owner@example.com' };
    mocks.clientPost.mockImplementation(async (url: string) => {
      if (url === '/admin/check-updates') return { data: staleBackupUpdate };
      if (url === '/admin/self-update') throw new Error('socket closed after request upload');
      return { data: {} };
    });
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/gateway/health')) {
        return { data: { ok: true, openclawVersion: { restartRecommended: false } } };
      }
      if (url === '/system/maintenance') return { data: readyMaintenanceStatus };
      return { data: null };
    });
    mocks.waitForExpectedPortalVersion.mockReturnValueOnce(lostResponseReadback.promise);

    render(
      <MemoryRouter
        initialEntries={['/dashboard']}
      >
        <DashboardUpdateHarness />
      </MemoryRouter>,
    );
    const leaveDashboard = screen.getByRole('button', { name: 'Leave Dashboard' });
    const currentRoute = screen.getByLabelText('Current route');

    await waitFor(() => expect(screen.getByText('Backup is stale')).toBeInTheDocument(), { timeout: 3000 });
    const reviewButton = screen.getByRole('button', { name: 'Review & update' });
    fireEvent.click(reviewButton);
    fireEvent.click(screen.getByRole('radio', { name: 'Continue without a fresh backup' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Type UPDATE PORTAL to continue/i }), {
      target: { value: 'UPDATE PORTAL' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update without backup' }));

    await waitFor(() => expect(mocks.waitForExpectedPortalVersion).toHaveBeenCalledWith('4.1.0'));
    expect(screen.getByText(/updater response was interrupted/i)).toBeVisible();
    expect(screen.getByRole('dialog', { name: 'Install Portal v4.1.0' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Starting signed updater…' })).toHaveAttribute('aria-busy', 'true');
    expect(reviewButton).toBeDisabled();
    expect(reviewButton).toHaveTextContent('Update dialog open');
    expect(document.querySelectorAll('button[aria-busy="true"]')).toHaveLength(1);

    const unload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(unload)).toBe(false);
    expect(unload.defaultPrevented).toBe(true);
    fireEvent.pointerDown(leaveDashboard);
    fireEvent.click(leaveDashboard);
    expect(currentRoute).toHaveTextContent('/dashboard');

    await act(async () => {
      lostResponseReadback.resolve(false);
      await lostResponseReadback.promise;
    });

    expect(await screen.findByText(/could not confirm the reviewed version within 10 minutes/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Update without backup' })).toBeEnabled();
    fireEvent.click(leaveDashboard);
    expect(currentRoute).toHaveTextContent('/settings');
  });

  it('retains the update dialog and blocks shell, router, history, and unload until version readback settles', async () => {
    const versionReadback = deferred<boolean>();
    mockOwnerBackgroundChecks(staleBackupUpdate);
    mocks.waitForExpectedPortalVersion.mockReturnValueOnce(versionReadback.promise);

    render(
      <MemoryRouter
        initialEntries={['/dashboard']}
      >
        <DashboardUpdateHarness />
      </MemoryRouter>,
    );
    const logoutShellAction = screen.getByRole('button', { name: 'Logout shell action' });
    const leaveDashboard = screen.getByRole('button', { name: 'Leave Dashboard' });
    const currentRoute = screen.getByLabelText('Current route');

    await waitFor(() => expect(screen.getByText('Backup is stale')).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Review & update' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Continue without a fresh backup' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Type UPDATE PORTAL to continue/i }), {
      target: { value: 'UPDATE PORTAL' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update without backup' }));

    await waitFor(() => expect(mocks.waitForExpectedPortalVersion).toHaveBeenCalledWith('4.1.0'));
    expect(screen.getByRole('dialog', { name: 'Install Portal v4.1.0' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Starting signed updater…' })).toHaveAttribute('aria-busy', 'true');

    const unload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(unload)).toBe(false);
    expect(unload.defaultPrevented).toBe(true);
    fireEvent.pointerDown(logoutShellAction);
    fireEvent.click(logoutShellAction);
    fireEvent.click(leaveDashboard);
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(mocks.shellAction).not.toHaveBeenCalled();
    expect(currentRoute).toHaveTextContent('/dashboard');
    expect(screen.getByRole('dialog', { name: 'Install Portal v4.1.0' })).toBeVisible();

    await act(async () => {
      versionReadback.resolve(false);
      await versionReadback.promise;
    });

    expect(await screen.findByText(/did not report the new version within 10 minutes/i)).toBeVisible();
    expect(screen.getByRole('dialog', { name: 'Install Portal v4.1.0' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Update without backup' })).toBeEnabled();

    fireEvent.click(logoutShellAction);
    fireEvent.click(leaveDashboard);
    expect(mocks.shellAction).toHaveBeenCalledTimes(1);
    expect(currentRoute).toHaveTextContent('/settings');
  });

  it('creates and verifies a fresh backup before asking the backend to admit the update', async () => {
    mocks.authUser.current = { id: 'owner-1', role: 'OWNER', email: 'owner@example.com' };
    let backupStatusReads = 0;
    const freshBackupUpdate = {
      ...staleBackupUpdate,
      preparation: {
        ...staleBackupUpdate.preparation,
        backup: {
          state: 'fresh',
          maxAgeHours: 24,
          newestCreatedAt: new Date().toISOString(),
          ageHours: 0,
          activeStatus: null,
        },
      },
    };
    mocks.clientPost.mockImplementation(async (url: string, body?: unknown) => {
      if (url === '/admin/check-updates') return { data: staleBackupUpdate };
      if (url === '/backups/create') return { data: { status: 'queued', id: 'backup-test' } };
      if (url === '/admin/self-update') {
        throw Object.assign(new Error('Stop after fresh-backup admission request'), {
          response: { data: { error: 'Fresh backup accepted; updater intentionally not started in this test', body } },
        });
      }
      return { data: {} };
    });
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/gateway/health')) {
        return { data: { ok: true, openclawVersion: { restartRecommended: false } } };
      }
      if (url === '/system/maintenance') return { data: readyMaintenanceStatus };
      if (url === '/backups/status') {
        backupStatusReads += 1;
        return { data: { status: backupStatusReads === 1 ? 'running' : 'completed' } };
      }
      if (url === '/admin/update-status') return { data: freshBackupUpdate };
      return { data: null };
    });

    render(<DashboardPage />);

    await waitFor(() => expect(screen.getByText('Backup is stale')).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Review & update' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Type UPDATE PORTAL to continue/i }), {
      target: { value: 'UPDATE PORTAL' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Back up & update' }));

    await waitFor(() => {
      expect(mocks.clientPost).toHaveBeenCalledWith('/admin/self-update', {
        confirmation: 'UPDATE PORTAL',
        backupDecision: 'use-current',
        expectedVersion: '4.1.0',
      });
    }, { timeout: 8000 });
    expect(mocks.clientPost).toHaveBeenCalledWith('/backups/create', { type: 'daily' });
    expect(backupStatusReads).toBe(2);
    expect(mocks.clientGet).toHaveBeenCalledWith('/admin/update-status', { _silent: true });
    expect(await screen.findByText('Fresh backup accepted; updater intentionally not started in this test')).toBeInTheDocument();
  }, 10_000);

  it('shows an honest fallback instead of rendering unverified update prose', async () => {
    mockOwnerBackgroundChecks({
      ...verifiedUpdate,
      detailsStatus: 'unavailable',
      details: {
        ...verifiedUpdate.details,
        highlights: ['Unverified remote prose must not render.'],
      },
    });
    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'View details' })).toBeInTheDocument();
    }, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'View details' }));

    expect(screen.getByText('Verified update details are unavailable.')).toBeInTheDocument();
    expect(screen.getByText(/No unverified release notes are shown here/)).toBeInTheDocument();
    expect(screen.queryByText('Unverified remote prose must not render.')).not.toBeInTheDocument();
    expect(screen.queryByText('Project Chat now supports qualified provider lanes.')).not.toBeInTheDocument();
  });

  it('does not render duplicate highlights as verified release details', async () => {
    mockOwnerBackgroundChecks({
      ...verifiedUpdate,
      details: {
        ...verifiedUpdate.details,
        highlights: ['Repeated release claim.', 'Repeated release claim.'],
      },
    });
    render(<DashboardPage />);

    await waitFor(
      () => expect(screen.getByRole('button', { name: 'View details' })).toBeInTheDocument(),
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByRole('button', { name: 'View details' }));
    expect(screen.getByText('Verified update details are unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('Repeated release claim.')).not.toBeInTheDocument();
  });

  it('keeps a cold maintenance scan pending until the 202 response becomes a ready 200 snapshot', async () => {
    mocks.authUser.current = { id: 'owner-1', role: 'OWNER', email: 'owner@example.com' };
    mocks.clientPost.mockResolvedValue({ data: { ...verifiedUpdate, updateAvailable: false } });
    let maintenanceRequestCount = 0;
    let releaseReadyResponse!: () => void;
    const readyResponseGate = new Promise<void>((resolve) => {
      releaseReadyResponse = resolve;
    });
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/gateway/health')) {
        return { data: { ok: true, openclawVersion: { restartRecommended: false } } };
      }
      if (url === '/system/maintenance') {
        maintenanceRequestCount += 1;
        if (maintenanceRequestCount === 1) {
          return {
            status: 202,
            data: coldMaintenanceStatus,
          };
        }
        await readyResponseGate;
        return {
          status: 200,
          data: {
            ready: true,
            cached: true,
            refreshing: false,
            checkedAt: '2026-07-20T12:00:00.000Z',
            status: 'critical',
            summary: '1 maintenance item needs attention.',
            host: {
              hostname: 'portal-test',
              os: 'Test Linux',
              kernel: '6.8.0',
              uptimeSeconds: 3600,
            },
            issues: [{
              id: 'daily-backup-failed',
              title: 'Daily backup failed',
              detail: 'The most recent scheduled backup did not complete.',
              severity: 'critical',
              category: 'backups',
              recommendation: 'Review the backup job.',
              automationSafe: false,
            }],
            actions: [],
          },
        };
      }
      return { data: null };
    });

    render(<DashboardPage />);

    await waitFor(() => expect(maintenanceRequestCount).toBeGreaterThanOrEqual(1), { timeout: 3000 });
    expect(screen.getByText('Server maintenance').parentElement).toHaveTextContent('Scanning');
    expect(screen.queryByText('Server maintenance needs attention')).not.toBeInTheDocument();
    expect(screen.queryByText(/unknown host/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/kernel unknown/i)).not.toBeInTheDocument();

    await waitFor(() => expect(maintenanceRequestCount).toBe(2), { timeout: 4000 });
    releaseReadyResponse();
    expect(await screen.findByText('1 maintenance item needs attention.')).toBeInTheDocument();
    expect(screen.getByText(/Test Linux · kernel 6\.8\.0/)).toBeInTheDocument();
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    const maintenanceCalls = mocks.clientGet.mock.calls.filter(([url]) => url === '/system/maintenance');
    expect(maintenanceCalls).toHaveLength(2);
    for (const [, config] of maintenanceCalls) {
      expect(config).toMatchObject({ _silent: true });
    }
  }, 8000);

  it('stops a cold maintenance poll immediately when the refresh has failed', async () => {
    mocks.authUser.current = { id: 'owner-1', role: 'OWNER', email: 'owner@example.com' };
    mocks.clientPost.mockResolvedValue({ data: { ...verifiedUpdate, updateAvailable: false } });
    let maintenanceRequestCount = 0;
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/gateway/health')) {
        return { data: { ok: true, openclawVersion: { restartRecommended: false } } };
      }
      if (url === '/system/maintenance') {
        maintenanceRequestCount += 1;
        return {
          status: 202,
          data: {
            ...coldMaintenanceStatus,
            refreshError: 'Maintenance status refresh failed',
          },
        };
      }
      return { data: null };
    });

    render(<DashboardPage />);

    await waitFor(() => expect(maintenanceRequestCount).toBe(1), { timeout: 3000 });
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    const maintenanceCalls = mocks.clientGet.mock.calls.filter(([url]) => url === '/system/maintenance');
    expect(maintenanceCalls).toHaveLength(1);
    expect(maintenanceCalls[0][1]).toMatchObject({ _silent: true });
    expect(screen.queryByText(/unknown host/i)).not.toBeInTheDocument();
  }, 5000);

  it('bounds a cold maintenance scan that never becomes ready', async () => {
    mocks.authUser.current = { id: 'owner-1', role: 'OWNER', email: 'owner@example.com' };
    mocks.clientPost.mockResolvedValue({ data: { ...verifiedUpdate, updateAvailable: false } });
    let maintenanceRequestCount = 0;
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/gateway/health')) {
        return { data: { ok: true, openclawVersion: { restartRecommended: false } } };
      }
      if (url === '/system/maintenance') {
        maintenanceRequestCount += 1;
        return { status: 202, data: { ...coldMaintenanceStatus } };
      }
      return { data: null };
    });

    render(<DashboardPage />);

    // One initial request plus the explicit six-request Dashboard follow-up budget.
    await waitFor(() => expect(maintenanceRequestCount).toBe(7), { timeout: 4000 });
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    expect(maintenanceRequestCount).toBe(7);
    const maintenanceCalls = mocks.clientGet.mock.calls.filter(([url]) => url === '/system/maintenance');
    expect(maintenanceCalls).toHaveLength(7);
    expect(maintenanceCalls.every(([, config]) => config?._silent === true)).toBe(true);
  }, 6000);
});
