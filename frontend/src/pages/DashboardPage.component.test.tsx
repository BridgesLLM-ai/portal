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
  monitorPortalSelfUpdate: vi.fn(),
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

vi.mock('../utils/portalUpdateProgress', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/portalUpdateProgress')>();
  return {
    ...actual,
    monitorPortalSelfUpdate: mocks.monitorPortalSelfUpdate,
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

const UPDATE_OPERATION_ID = 'a'.repeat(32);

const idleUpdateProgress = {
  schema: 1,
  operationId: null,
  previousVersion: null,
  expectedVersion: null,
  status: 'idle',
  phase: 'idle',
  percent: 0,
  label: 'No update is running',
  detail: '',
  startedAt: null,
  updatedAt: null,
  finishedAt: null,
  events: [],
  logAvailable: false,
};

function updateProgress(
  status: 'starting' | 'running' | 'recovering' | 'succeeded' | 'failed' | 'rolled_back' | 'updated_with_errors' | 'recovery_required',
  overrides: Record<string, unknown> = {},
) {
  const terminal = ['succeeded', 'failed', 'rolled_back', 'updated_with_errors', 'recovery_required'].includes(status);
  return {
    schema: 1,
    operationId: UPDATE_OPERATION_ID,
    previousVersion: '4.0.0',
    expectedVersion: '4.1.0',
    status,
    phase: status === 'running' ? 'installing-release' : status.replace(/_/g, '-'),
    percent: status === 'succeeded' ? 100 : terminal ? 88 : 48,
    label: status === 'running' ? 'Installing signed release' : `Update ${status.replace(/_/g, ' ')}`,
    detail: status === 'running'
      ? 'Applying the verified Portal bundle and database migrations.'
      : `Durable terminal status: ${status.replace(/_/g, ' ')}.`,
    startedAt: '2026-08-10T12:00:00.000Z',
    updatedAt: '2026-08-10T12:02:00.000Z',
    finishedAt: terminal ? '2026-08-10T12:03:00.000Z' : null,
    events: [{
      status: 'running',
      phase: 'release-verified',
      percent: 25,
      label: 'Release verified',
      detail: 'Manifest, signature, and archive hash matched.',
      at: '2026-08-10T12:00:30.000Z',
    }],
    logAvailable: true,
    ...overrides,
  };
}

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
    if (url.startsWith('/admin/self-update/progress')) return { data: idleUpdateProgress };
    return { data: null };
  });
}

function mockOwnerBackgroundChecks(update: any, portalProgress: any = idleUpdateProgress) {
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
    if (url.startsWith('/admin/self-update/progress')) {
      if (portalProgress instanceof Error) throw portalProgress;
      return { data: portalProgress };
    }
    return { data: null };
  });
}

describe('dashboard role-aware loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.clientGet.mockReset();
    mocks.clientPost.mockReset();
    mocks.monitorPortalSelfUpdate.mockReset().mockResolvedValue({ outcome: 'timeout', progress: null });
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
    expect(screen.getByText(/newest authenticated comprehensive backup candidate is 3 days old/i)).toBeInTheDocument();
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

  it('labels a recent authenticated backup as a candidate awaiting strict update admission verification', async () => {
    mockOwnerBackgroundChecks({
      ...staleBackupUpdate,
      preparation: {
        ...staleBackupUpdate.preparation,
        backup: {
          state: 'candidate',
          maxAgeHours: 24,
          newestCreatedAt: '2026-07-20T19:00:00.000Z',
          ageHours: 1,
          activeStatus: null,
        },
      },
    });
    render(<DashboardPage />);

    await waitFor(() => expect(screen.getByText('Backup candidate found')).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText(/Strict restore verification will run before the update is admitted/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review & update' }));
    expect(screen.getByRole('radio', { name: 'Use the recent backup' })).toBeChecked();
    expect(screen.getByText('Use the recent backup candidate')).toBeInTheDocument();
    expect(screen.getByText(/server will run strict restore verification before the updater starts/i)).toBeInTheDocument();
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

  it('reattaches after a lost admission response without accepting the prior terminal receipt or allowing a second POST', async () => {
    const monitorResult = deferred<any>();
    const guardedReads: unknown[] = [];
    const runningProgress = updateProgress('running');
    const priorTerminalProgress = updateProgress('succeeded', {
      operationId: 'b'.repeat(32),
      startedAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:03:00.000Z',
      finishedAt: '2020-01-01T00:03:00.000Z',
    });
    let admissionAttempted = false;
    let reconciliationRead = 0;
    mocks.authUser.current = { id: 'owner-1', role: 'OWNER', email: 'owner@example.com' };
    mocks.clientPost.mockImplementation(async (url: string) => {
      if (url === '/admin/check-updates') return { data: staleBackupUpdate };
      if (url === '/admin/self-update') {
        admissionAttempted = true;
        throw new Error('socket closed after request upload');
      }
      return { data: {} };
    });
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/gateway/health')) {
        return { data: { ok: true, openclawVersion: { restartRecommended: false } } };
      }
      if (url === '/system/maintenance') return { data: readyMaintenanceStatus };
      if (url.startsWith('/admin/self-update/progress')) {
        if (!admissionAttempted) return { data: priorTerminalProgress };
        reconciliationRead += 1;
        return { data: reconciliationRead === 1 ? priorTerminalProgress : runningProgress };
      }
      return { data: null };
    });
    mocks.monitorPortalSelfUpdate.mockImplementationOnce(async (
      _expectedVersion: string,
      _operationId: string | undefined,
      api: { readProgress: (operationId?: string) => Promise<unknown> },
      options: { onProgress?: (progress: any) => void; onConnectionChange?: (state: 'connected' | 'reconnecting') => void },
    ) => {
      guardedReads.push(await api.readProgress());
      guardedReads.push(await api.readProgress());
      options.onProgress?.(runningProgress);
      options.onConnectionChange?.('reconnecting');
      return monitorResult.promise;
    });

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

    await waitFor(() => expect(mocks.monitorPortalSelfUpdate).toHaveBeenCalled());
    expect(mocks.monitorPortalSelfUpdate.mock.calls[0][0]).toBe('4.1.0');
    expect(mocks.monitorPortalSelfUpdate.mock.calls[0][1]).toBeUndefined();
    expect(mocks.monitorPortalSelfUpdate.mock.calls[0][3]?.notBefore).toBeUndefined();
    expect(guardedReads[0]).toBeNull();
    expect(guardedReads[1]).toEqual(runningProgress);
    expect(screen.getByRole('dialog', { name: 'Updating Portal to v4.1.0' })).toBeVisible();
    expect(screen.getByRole('progressbar', { name: 'Installing signed release' })).toHaveAttribute('aria-valuenow', '48');
    expect(screen.getByText('Installing signed release')).toHaveFocus();
    expect(screen.queryByRole('textbox', { name: /UPDATE PORTAL/i })).not.toBeInTheDocument();
    expect(screen.getByText('Release verified')).toBeVisible();
    expect(screen.getByText(/updater continues on the server/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Installing signed release' })).not.toBeInTheDocument();
    expect(reviewButton).toBeDisabled();
    expect(reviewButton).toHaveTextContent('Update dialog open');
    expect(document.querySelectorAll('button[aria-busy="true"]')).toHaveLength(0);

    const unload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(unload)).toBe(true);
    expect(unload.defaultPrevented).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Hide for now' }));
    expect(screen.queryByRole('dialog', { name: 'Updating Portal to v4.1.0' })).not.toBeInTheDocument();
    expect(reviewButton).toHaveTextContent('View update progress');
    expect(reviewButton).toBeEnabled();
    expect(screen.getByRole('progressbar', { name: 'Portal update progress' })).toHaveAttribute('aria-valuenow', '48');
    fireEvent.click(reviewButton);
    expect(screen.getByRole('dialog', { name: 'Updating Portal to v4.1.0' })).toBeVisible();

    await act(async () => {
      monitorResult.resolve({ outcome: 'timeout', progress: runningProgress });
      await monitorResult.promise;
    });

    expect(await screen.findByRole('dialog', { name: 'Portal update status is unconfirmed' })).toBeVisible();
    expect(screen.getByText(/Do not start another update while this operation remains unconfirmed/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: /update without backup/i })).not.toBeInTheDocument();
    expect(mocks.clientPost.mock.calls.filter(([url]) => url === '/admin/self-update')).toHaveLength(1);
    fireEvent.click(leaveDashboard);
    expect(currentRoute).toHaveTextContent('/settings');
  });

  it('ends a lost admission with no durable receipt as unconfirmed instead of staying busy forever', async () => {
    mockOwnerBackgroundChecks(staleBackupUpdate, idleUpdateProgress);
    mocks.clientPost.mockImplementation(async (url: string) => {
      if (url === '/admin/check-updates') return { data: staleBackupUpdate };
      if (url === '/admin/self-update') throw new Error('socket closed before admission was acknowledged');
      return { data: {} };
    });
    mocks.monitorPortalSelfUpdate.mockResolvedValueOnce({ outcome: 'timeout', progress: null });

    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText('Backup is stale')).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Review & update' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Continue without a fresh backup' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Type UPDATE PORTAL to continue/i }), {
      target: { value: 'UPDATE PORTAL' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update without backup' }));

    expect(await screen.findByRole('dialog', { name: 'Portal update status is unconfirmed' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Do not start another update');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /UPDATE PORTAL/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry signed update|update without backup/i })).not.toBeInTheDocument();
    expect(mocks.clientPost.mock.calls.filter(([url]) => url === '/admin/self-update')).toHaveLength(1);

    const unload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(unload)).toBe(true);
    expect(unload.defaultPrevented).toBe(false);
  });

  it('attaches a new terminal receipt after a lost response when it differs from the pre-POST baseline', async () => {
    const baseline = updateProgress('succeeded', {
      operationId: 'b'.repeat(32),
      startedAt: '2026-08-09T12:00:00.000Z',
      updatedAt: '2026-08-09T12:03:00.000Z',
      finishedAt: '2026-08-09T12:03:00.000Z',
    });
    const newFailure = updateProgress('failed', {
      operationId: UPDATE_OPERATION_ID,
      label: 'Update stopped before changes were made',
      detail: 'The host safety check rejected an unsafe scheduled cleanup.',
    });
    let admissionAttempted = false;
    mockOwnerBackgroundChecks(staleBackupUpdate, baseline);
    mocks.clientPost.mockImplementation(async (url: string) => {
      if (url === '/admin/check-updates') return { data: staleBackupUpdate };
      if (url === '/admin/self-update') {
        admissionAttempted = true;
        throw new Error('response lost after updater terminalized');
      }
      return { data: {} };
    });
    const stableGet = mocks.clientGet.getMockImplementation()!;
    mocks.clientGet.mockImplementation(async (url: string, config?: unknown) => {
      if (url.startsWith('/admin/self-update/progress')) {
        return { data: admissionAttempted ? newFailure : baseline };
      }
      return stableGet(url, config);
    });
    mocks.monitorPortalSelfUpdate.mockImplementationOnce(async (
      _expectedVersion: string,
      _operationId: string | undefined,
      api: { readProgress: () => Promise<unknown> },
      options: { onProgress?: (progress: any) => void },
    ) => {
      const attached = await api.readProgress();
      expect(attached).toEqual(newFailure);
      options.onProgress?.(newFailure);
      return { outcome: 'failed', progress: newFailure, error: newFailure.detail };
    });

    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText('Backup is stale')).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Review & update' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Continue without a fresh backup' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Type UPDATE PORTAL to continue/i }), {
      target: { value: 'UPDATE PORTAL' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update without backup' }));

    expect(await screen.findByRole('dialog', { name: 'Portal update failed' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('The host safety check rejected an unsafe scheduled cleanup.');
    expect(mocks.clientPost.mock.calls.filter(([url]) => url === '/admin/self-update')).toHaveLength(1);
  });

  it('locks admission, then releases shell, router, history, and unload once the operation is durable', async () => {
    const admissionResult = deferred<{ data: { operationId: string } }>();
    const monitorResult = deferred<any>();
    const runningProgress = updateProgress('running');
    let emitDurableProgress!: () => void;
    mockOwnerBackgroundChecks(staleBackupUpdate);
    mocks.clientPost.mockImplementation(async (url: string) => {
      if (url === '/admin/check-updates') return { data: staleBackupUpdate };
      if (url === '/admin/self-update') return admissionResult.promise;
      return { data: {} };
    });
    mocks.monitorPortalSelfUpdate.mockImplementationOnce(async (
      _expectedVersion: string,
      _operationId: string | undefined,
      _api: unknown,
      options: { onProgress?: (progress: any) => void },
    ) => {
      emitDurableProgress = () => options.onProgress?.(runningProgress);
      return monitorResult.promise;
    });

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

    await waitFor(() => {
      expect(mocks.clientPost.mock.calls.filter(([url]) => url === '/admin/self-update')).toHaveLength(1);
    });
    const admissionUnload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(admissionUnload)).toBe(false);
    expect(admissionUnload.defaultPrevented).toBe(true);
    fireEvent.pointerDown(logoutShellAction);
    fireEvent.click(logoutShellAction);
    fireEvent.click(leaveDashboard);
    expect(mocks.shellAction).not.toHaveBeenCalled();
    expect(currentRoute).toHaveTextContent('/dashboard');

    await act(async () => {
      admissionResult.resolve({ data: { operationId: UPDATE_OPERATION_ID } });
      await admissionResult.promise;
    });
    await waitFor(() => expect(mocks.monitorPortalSelfUpdate).toHaveBeenCalled());
    expect(mocks.monitorPortalSelfUpdate.mock.calls[0][0]).toBe('4.1.0');
    expect(mocks.monitorPortalSelfUpdate.mock.calls[0][1]).toBe(UPDATE_OPERATION_ID);
    expect(screen.getByRole('dialog', { name: 'Install Portal v4.1.0' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Starting signed updater…' })).toHaveAttribute('aria-busy', 'true');

    const unload = new Event('beforeunload', { cancelable: true });
    // A POST-returned operation ID is already durable, so admission is over
    // and the global lock is released even before the first phase event.
    expect(window.dispatchEvent(unload)).toBe(true);
    expect(unload.defaultPrevented).toBe(false);

    await act(async () => {
      emitDurableProgress();
    });
    expect(screen.getByRole('dialog', { name: 'Updating Portal to v4.1.0' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hide for now' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Hide for now' }));
    fireEvent.pointerDown(logoutShellAction);
    fireEvent.click(logoutShellAction);
    fireEvent.click(leaveDashboard);
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(mocks.shellAction).toHaveBeenCalledTimes(1);
    expect(currentRoute).toHaveTextContent('/settings');
  });

  it('reattaches an active server-owned update on mount and restores determinate progress', async () => {
    const monitorResult = deferred<any>();
    const runningProgress = updateProgress('running', {
      percent: 61,
      label: 'Restarting Portal services',
      detail: 'The API may be briefly unavailable while services restart.',
    });
    sessionStorage.setItem('dashboard-self-update-operation-id', UPDATE_OPERATION_ID);
    sessionStorage.setItem('dashboard-self-update-expected-version', '4.1.0');
    mockOwnerBackgroundChecks(staleBackupUpdate, new Error('Portal restarting'));
    mocks.monitorPortalSelfUpdate.mockImplementationOnce(async (
      _expectedVersion: string,
      _operationId: string | undefined,
      _api: unknown,
      options: { onProgress?: (progress: any) => void; onConnectionChange?: (state: 'connected' | 'reconnecting') => void },
    ) => {
      options.onProgress?.(runningProgress);
      options.onConnectionChange?.('reconnecting');
      return monitorResult.promise;
    });

    render(<DashboardPage />);

    expect(await screen.findByRole('dialog', { name: 'Updating Portal to v4.1.0' })).toBeVisible();
    expect(mocks.clientGet).toHaveBeenCalledWith(
      `/admin/self-update/progress?operationId=${UPDATE_OPERATION_ID}`,
      { _silent: true },
    );
    expect(mocks.monitorPortalSelfUpdate.mock.calls[0][1]).toBe(UPDATE_OPERATION_ID);
    expect(screen.getByRole('progressbar', { name: 'Restarting Portal services' })).toHaveAttribute('aria-valuenow', '61');
    expect(screen.getByText(/live feedback will resume automatically/i)).toBeVisible();

    await act(async () => {
      const terminal = updateProgress('failed');
      monitorResult.resolve({ outcome: 'failed', progress: terminal, error: terminal.detail });
      await monitorResult.promise;
    });
  });

  it('keeps retrying current-operation discovery in a brand-new tab through a long backend restart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const monitorResult = deferred<any>();
    let view: ReturnType<typeof render> | undefined;
    try {
      const runningProgress = updateProgress('running', {
        percent: 61,
        label: 'Restarting Portal services',
        detail: 'The API returned and durable update tracking resumed.',
      });
      mockOwnerBackgroundChecks(staleBackupUpdate, runningProgress);
      const stableGet = mocks.clientGet.getMockImplementation()!;
      let progressReads = 0;
      mocks.clientGet.mockImplementation(async (url: string, config?: unknown) => {
        if (url.startsWith('/admin/self-update/progress')) {
          progressReads += 1;
          if (progressReads <= 13) throw new Error('Portal is restarting');
        }
        return stableGet(url, config);
      });
      mocks.monitorPortalSelfUpdate.mockImplementationOnce(async (
        _expectedVersion: string,
        _operationId: string | undefined,
        _api: unknown,
        options: { onProgress?: (progress: any) => void },
      ) => {
        options.onProgress?.(runningProgress);
        return monitorResult.promise;
      });

      view = render(<DashboardPage />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(progressReads).toBe(1);

      // Thirteen failed reads outlive the old one-minute discovery ceiling.
      // GET-only discovery must continue with bounded backoff until the owner
      // current receipt becomes readable; it must never submit a second job.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400_000);
      });

      expect(progressReads).toBeGreaterThanOrEqual(14);
      expect(mocks.monitorPortalSelfUpdate).toHaveBeenCalledWith(
        '4.1.0',
        UPDATE_OPERATION_ID,
        expect.anything(),
        expect.anything(),
      );
      expect(screen.getByRole('dialog', { name: 'Updating Portal to v4.1.0' })).toBeVisible();
      expect(screen.getByRole('progressbar', { name: 'Restarting Portal services' })).toHaveAttribute('aria-valuenow', '61');
      expect(mocks.clientPost.mock.calls.filter(([url]) => url === '/admin/self-update')).toHaveLength(0);

      await act(async () => {
        const terminal = updateProgress('failed');
        monitorResult.resolve({ outcome: 'failed', progress: terminal, error: terminal.detail });
        await monitorResult.promise;
      });
    } finally {
      view?.unmount();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('shows recovery-required as a durable terminal result and exposes no second update action', async () => {
    const recoveryProgress = updateProgress('recovery_required', {
      label: 'Manual recovery required',
      detail: 'Automatic rollback could not restore every host integration.',
    });
    // Blocking attention receipts reappear from the server even after a new
    // tab or an explicit local acknowledgement cleared session tracking.
    mockOwnerBackgroundChecks(staleBackupUpdate, recoveryProgress);

    render(<DashboardPage />);

    expect(await screen.findByRole('dialog', { name: 'Portal update needs recovery' })).toBeVisible();
    expect(screen.getByText('Manual recovery required')).toBeVisible();
    const attentionDetails = screen.getByLabelText('Update attention details');
    expect(attentionDetails).toHaveTextContent(`Failed phase${recoveryProgress.phase}`);
    expect(attentionDetails).toHaveTextContent(UPDATE_OPERATION_ID);
    expect(attentionDetails).toHaveTextContent('v4.0.0 / v4.1.0');
    expect(attentionDetails).toHaveTextContent('docs/PORTAL_UPDATE_ATTENTION_RECOVERY.md');
    expect(screen.getByLabelText('Read-only update recovery checks')).toHaveTextContent(
      'bridgesllm-portal-self-update.service',
    );
    expect(screen.getByLabelText('Read-only update recovery checks')).toHaveTextContent(
      'active-update.json',
    );
    expect(screen.getByRole('link', { name: 'Open root recovery procedure' })).toHaveAttribute(
      'href',
      'https://github.com/BridgesLLM-ai/portal/blob/main/docs/PORTAL_UPDATE_ATTENTION_RECOVERY.md',
    );
    expect(screen.getByText(/second update is disabled until this host state is reviewed/i)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: /UPDATE PORTAL/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install update|retry signed update|update without backup/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View installer log' })).toHaveAttribute(
      'href',
      `/api/admin/self-update/log?operationId=${UPDATE_OPERATION_ID}`,
    );
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
    expect(mocks.monitorPortalSelfUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Portal update needs recovery' })).not.toBeInTheDocument();
    expect(sessionStorage.getItem('dashboard-self-update-operation-id')).toBeNull();
    expect(sessionStorage.getItem('dashboard-self-update-expected-version')).toBeNull();
    expect(mocks.clientPost.mock.calls.filter(([url]) => url === '/admin/self-update')).toHaveLength(0);
  });

  it('keeps a follow-up-required operation visible after the release is no longer available', async () => {
    const attentionProgress = updateProgress('updated_with_errors', {
      label: 'Portal updated; host cleanup needs attention',
      detail: 'The target Portal is running, but a follow-up host task failed.',
    });
    mockOwnerBackgroundChecks({
      ...verifiedUpdate,
      current: '4.1.0',
      latest: '4.1.0',
      updateAvailable: false,
    }, attentionProgress);

    render(<DashboardPage />);

    expect(await screen.findByRole('dialog', { name: 'Portal updated with follow-up required' })).toBeVisible();
    expect(screen.getByText(/new Portal committed and is serving, but ancillary host work failed/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog', { name: 'Portal updated with follow-up required' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Portal updated; host cleanup needs attention');
    expect(screen.getByRole('button', { name: 'Review update result' })).toBeEnabled();
    expect(screen.queryByText(/Update available:/i)).not.toBeInTheDocument();
  });

  it('reattaches the blocking attention receipt when admission rejects a blind retry', async () => {
    const recoveryProgress = updateProgress('recovery_required', {
      label: 'Manual recovery required',
      detail: 'Repair the surviving transaction before another update.',
    });
    let admissionAttempted = false;
    mocks.authUser.current = { id: 'owner-1', role: 'OWNER', email: 'owner@example.com' };
    mocks.clientPost.mockImplementation(async (url: string) => {
      if (url === '/admin/check-updates') return { data: staleBackupUpdate };
      if (url === '/admin/self-update') {
        admissionAttempted = true;
        throw Object.assign(new Error('attention required'), {
          response: { data: { code: 'PORTAL_UPDATE_ATTENTION_REQUIRED' } },
        });
      }
      return { data: {} };
    });
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/gateway/health')) {
        return { data: { ok: true, openclawVersion: { restartRecommended: false } } };
      }
      if (url === '/system/maintenance') return { data: readyMaintenanceStatus };
      if (url.startsWith('/admin/self-update/progress')) {
        return { data: admissionAttempted ? recoveryProgress : idleUpdateProgress };
      }
      return { data: null };
    });

    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText('Backup is stale')).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Review & update' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Continue without a fresh backup' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Type UPDATE PORTAL to continue/i }), {
      target: { value: 'UPDATE PORTAL' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update without backup' }));

    expect(await screen.findByRole('dialog', { name: 'Portal update needs recovery' })).toBeVisible();
    expect(screen.getByText('Manual recovery required')).toBeVisible();
    expect(mocks.monitorPortalSelfUpdate).not.toHaveBeenCalled();
    expect(mocks.clientPost.mock.calls.filter(([url]) => url === '/admin/self-update')).toHaveLength(1);
  });

  it.each([
    ['failed', 'Portal update failed', true],
    ['rolled_back', 'Portal update rolled back', true],
    ['updated_with_errors', 'Portal updated with follow-up required', false],
  ] as const)('renders the %s terminal status with the correct retry policy', async (status, title, retryable) => {
    const terminalProgress = updateProgress(status, {
      label: status === 'rolled_back' ? 'Previous Portal restored' : 'Portal updated; cleanup failed',
    });
    sessionStorage.setItem('dashboard-self-update-operation-id', UPDATE_OPERATION_ID);
    sessionStorage.setItem('dashboard-self-update-expected-version', '4.1.0');
    mockOwnerBackgroundChecks(staleBackupUpdate, terminalProgress);

    render(<DashboardPage />);

    expect(await screen.findByRole('dialog', { name: title })).toBeVisible();
    expect(screen.getByText(terminalProgress.label)).toBeVisible();
    if (retryable) {
      expect(screen.getByRole('button', { name: 'Retry signed update' })).toBeDisabled();
      expect(screen.getByRole('textbox', { name: /Type UPDATE PORTAL to continue/i })).toBeEnabled();
    } else {
      expect(screen.queryByRole('button', { name: 'Retry signed update' })).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: /UPDATE PORTAL/i })).not.toBeInTheDocument();
      expect(screen.getByText(/second update is disabled until this host state is reviewed/i)).toBeVisible();
    }
  });

  it('does not declare success or expose a retry when health responds without a terminal receipt', async () => {
    mockOwnerBackgroundChecks(staleBackupUpdate);
    mocks.clientPost.mockImplementation(async (url: string) => {
      if (url === '/admin/check-updates') return { data: staleBackupUpdate };
      if (url === '/admin/self-update') return { data: { operationId: UPDATE_OPERATION_ID } };
      return { data: {} };
    });
    mocks.monitorPortalSelfUpdate.mockResolvedValueOnce({ outcome: 'succeeded', progress: null });

    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText('Backup is stale')).toBeInTheDocument(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Review & update' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Continue without a fresh backup' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Type UPDATE PORTAL to continue/i }), {
      target: { value: 'UPDATE PORTAL' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update without backup' }));

    expect(await screen.findByRole('dialog', { name: 'Portal update status is unconfirmed' })).toBeVisible();
    expect(screen.getByText(/could not obtain a terminal updater receipt/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: /install update|retry signed update|update without backup/i })).not.toBeInTheDocument();
    expect(mocks.clientPost.mock.calls.filter(([url]) => url === '/admin/self-update')).toHaveLength(1);
  });

  it('creates a fresh authenticated backup candidate before asking the backend to strictly verify and admit it', async () => {
    mocks.authUser.current = { id: 'owner-1', role: 'OWNER', email: 'owner@example.com' };
    let backupStatusReads = 0;
    const freshBackupUpdate = {
      ...staleBackupUpdate,
      preparation: {
        ...staleBackupUpdate.preparation,
        backup: {
          state: 'candidate',
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
    expect(mocks.clientPost).toHaveBeenCalledWith('/backups/create', { type: 'comprehensive' });
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
