// @vitest-environment jsdom
import '../test/setup';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPage from './SettingsPage';

const mocks = vi.hoisted(() => ({
  authUser: {
    current: { id: 'owner-1', email: 'owner@example.com', username: 'owner', role: 'OWNER' } as any,
  },
  silentLogout: vi.fn(),
  getPortalSettings: vi.fn(),
  updatePortalSettings: vi.fn(),
  updateSearchVisibility: vi.fn(),
  sendTestEmail: vi.fn(),
  clientGet: vi.fn(),
  clientPost: vi.fn(),
  clientPut: vi.fn(),
  clientDelete: vi.fn(),
  twoFactorStatus: vi.fn(),
  twoFactorSetup: vi.fn(),
  twoFactorVerifySetup: vi.fn(),
  twoFactorDisable: vi.fn(),
  twoFactorSendEmailAuthenticated: vi.fn(),
  twoFactorRegenerateBackupCodes: vi.fn(),
  getCompatibilityHotfixStatus: vi.fn(),
  applyCompatibilityHotfix: vi.fn(),
  getConfigPath: vi.fn(),
  patchConfigPath: vi.fn(),
  runtimeStatus: vi.fn(),
  refreshPublicSettings: vi.fn(),
  remotePanelMutation: vi.fn(),
  publicSettings: {
    current: {
      originMode: 'domain',
      mail: { available: true, reason: null },
    } as any,
  },
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuthStore: () => ({ user: mocks.authUser.current, silentLogout: mocks.silentLogout }),
}));

vi.mock('../contexts/ThemeContext', () => ({
  useTheme: () => ({
    theme: 'dark',
    setTheme: vi.fn(),
    accentColor: '#6366f1',
    setAccentColor: vi.fn(),
    effectsMode: 'auto',
    setEffectsMode: vi.fn(),
    resolvedEffects: 'full',
  }),
}));

vi.mock('../api/settings', () => ({
  settingsAPI: {
    getPortalSettings: mocks.getPortalSettings,
    updatePortalSettings: mocks.updatePortalSettings,
    updateSearchVisibility: mocks.updateSearchVisibility,
    sendTestEmail: mocks.sendTestEmail,
  },
}));

vi.mock('../api/client', () => ({
  default: {
    get: mocks.clientGet,
    post: mocks.clientPost,
    put: mocks.clientPut,
    delete: mocks.clientDelete,
  },
}));

vi.mock('../api/auth', () => ({
  authAPI: {
    twoFactorStatus: mocks.twoFactorStatus,
    twoFactorSetup: mocks.twoFactorSetup,
    twoFactorVerifySetup: mocks.twoFactorVerifySetup,
    twoFactorDisable: mocks.twoFactorDisable,
    twoFactorSendEmailAuthenticated: mocks.twoFactorSendEmailAuthenticated,
    twoFactorRegenerateBackupCodes: mocks.twoFactorRegenerateBackupCodes,
  },
}));

vi.mock('../api/endpoints', () => ({
  gatewayAPI: {
    getCompatibilityHotfixStatus: mocks.getCompatibilityHotfixStatus,
    applyCompatibilityHotfix: mocks.applyCompatibilityHotfix,
    getConfigPath: mocks.getConfigPath,
    patchConfigPath: mocks.patchConfigPath,
  },
}));

vi.mock('../api/agentRuntime', () => ({
  agentRuntimeAPI: { status: mocks.runtimeStatus },
}));

vi.mock('../hooks/usePublicSettings', () => ({
  usePublicSettings: () => mocks.publicSettings.current,
  refreshPublicSettings: mocks.refreshPublicSettings,
}));

vi.mock('../utils/sounds', () => ({
  default: {
    click: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    isEnabled: vi.fn(() => true),
    getVolume: vi.fn(() => 0.5),
    setEnabled: vi.fn(),
    setVolume: vi.fn(),
    toggleOff: vi.fn(),
  },
}));

vi.mock('../components/settings/BackupsTab', () => ({ default: () => <div>Backups</div> }));
vi.mock('../components/ai-setup/AiProviderSetup', () => ({ default: () => <div>AI setup</div> }));
vi.mock('../components/settings/AgentZeroSetupPanel', () => ({ default: () => <div>Agent Zero setup</div> }));
vi.mock('../components/settings/OllamaTailnetSetup', async () => {
  const context = await vi.importActual<
    typeof import('../components/settings/SettingsMutationContext')
  >('../components/settings/SettingsMutationContext');
  return {
    default: function MockOllamaTailnetSetup({
      className,
      onStatusChange,
    }: {
      className?: string;
      onStatusChange?: (status: any) => void;
    }) {
      const mutation = context.useSettingsMutationCoordinator();
      const runMutation = () => {
        const owner = 'settings:ollama-remote-gpu:test';
        if (!mutation?.claim(owner)) return;
        void Promise.resolve(mocks.remotePanelMutation()).finally(() => {
          mutation.release(owner);
        });
      };
      return (
        <div className={className}>
          Remote GPU management
          <button type="button" onClick={runMutation}>
            Start Remote GPU mutation
          </button>
          <button
            type="button"
            onClick={() => onStatusChange?.({
              binding: {
                purposeId: 'PRIMARY',
                authority: {
                  id: 'native-binding-1',
                  generation: 1,
                  version: 1,
                  state: 'ACTIVE',
                },
              },
            })}
          >
            Complete Remote GPU setup
          </button>
          <button
            type="button"
            onClick={() => onStatusChange?.({
              binding: {
                purposeId: 'PRIMARY',
                authority: null,
              },
            })}
          >
            Remove Remote GPU
          </button>
        </div>
      );
    },
  };
});
vi.mock('../components/settings/FeatureReadinessPanel', () => ({ default: () => <div>Readiness</div> }));
vi.mock('../components/ImagePickerCropper', () => ({ default: () => null }));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderSettings(tab: string, extraQuery = '') {
  return render(
    <MemoryRouter
      initialEntries={[`/settings?tab=${tab}${extraQuery}`]}
    >
      <SettingsPage />
    </MemoryRouter>,
  );
}

const hotfixStatus = {
  supported: true,
  applied: false,
  confirmationPhrase: 'APPLY OPENCLAW HOTFIX',
  heartbeatRunner: null,
  replyBundle: null,
  executeRuntime: null,
  geminiCliBackend: null,
  detectorPatched: false,
  relayPatched: false,
  replyPatched: false,
  geminiCliPatched: false,
  geminiCliYoloPatched: false,
  geminiRuntimePatched: false,
  issues: ['missing'],
  note: null,
};

describe('SettingsPage synchronous action ownership', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (vi.isMockFunction(mock)) mock.mockReset();
    }
    mocks.authUser.current = { id: 'owner-1', email: 'owner@example.com', username: 'owner', role: 'OWNER' };
    mocks.publicSettings.current = {
      originMode: 'domain',
      mail: { available: true, reason: null },
    };
    mocks.getPortalSettings.mockResolvedValue({
      'appearance.portalName': 'Portal',
      'appearance.assistantName': 'Assistant',
      'system.searchEngineVisibility': 'hidden',
      'ollama.localEnabled': 'true',
      'ollama.defaultModel': 'qwen3.5:4b',
      'ollama.local.tier.snappy': 'qwen3.5:2b',
      'ollama.local.tier.smart': 'qwen3.5:4b',
      'ollama.local.tier.best': 'qwen3.5:9b',
    });
    mocks.updatePortalSettings.mockResolvedValue({});
    mocks.updateSearchVisibility.mockResolvedValue({});
    mocks.sendTestEmail.mockResolvedValue({ message: 'sent' });
    mocks.twoFactorStatus.mockResolvedValue({ enabled: false, method: null, backupCodesRemaining: 0 });
    mocks.twoFactorSetup.mockResolvedValue({ method: 'email', message: 'sent' });
    mocks.twoFactorVerifySetup.mockResolvedValue({ backupCodes: ['backup-1'] });
    mocks.twoFactorDisable.mockResolvedValue({ success: true, message: 'disabled' });
    mocks.twoFactorSendEmailAuthenticated.mockResolvedValue({ message: 'sent' });
    mocks.twoFactorRegenerateBackupCodes.mockResolvedValue({ backupCodes: ['backup-2'] });
    mocks.getCompatibilityHotfixStatus.mockResolvedValue(hotfixStatus);
    mocks.applyCompatibilityHotfix.mockResolvedValue({ status: { ...hotfixStatus, applied: true }, message: 'applied' });
    mocks.getConfigPath.mockResolvedValue({ value: false });
    mocks.patchConfigPath.mockResolvedValue({});
    mocks.runtimeStatus.mockResolvedValue({ gateway: { connected: true }, adapters: [] });
    mocks.refreshPublicSettings.mockResolvedValue(null);
    mocks.remotePanelMutation.mockResolvedValue(undefined);
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/admin/email-status') return { data: { connected: false, server: '', protocol: '', sender: '', url: '', error: null } };
      if (url === '/admin/mailboxes') return { data: { mailboxes: [{ userId: 'user-1', username: 'alice', email: 'alice@example.com', createdAt: '2026-07-01', lastLoginAt: null }] } };
      if (url === '/admin/coding-tools-status') return { data: { tools: [{ id: 'codex', name: 'Codex CLI', description: 'Coding agent', installed: false, version: '' }] } };
      if (url === '/admin/domain-status') return { data: { currentDomain: '', publicIp: '203.0.113.10', httpsActive: false } };
      if (url === '/ollama/models') return { data: { models: [], inventories: { local: { models: [] }, tailnet: { models: [] } } } };
      if (url === '/ollama/pulls') return { data: { pulls: [] } };
      if (url === '/ollama/recommendations') return { data: null };
      return { data: {} };
    });
    mocks.clientPost.mockResolvedValue({ data: {} });
    mocks.clientPut.mockResolvedValue({ data: {} });
    mocks.clientDelete.mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('fails closed when initial 2FA status is unavailable and offers an explicit retry', async () => {
    mocks.twoFactorStatus.mockRejectedValue(new Error('security status unavailable'));
    renderSettings('security');

    const panel = await screen.findByRole('tabpanel');
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Two-factor status could not be loaded',
    );
    expect(screen.queryByRole('button', { name: 'Enable Two-Factor Authentication' })).not.toBeInTheDocument();

    mocks.twoFactorStatus.mockResolvedValue({ enabled: false, method: null, backupCodesRemaining: 0 });
    await userEvent.click(screen.getByRole('button', { name: 'Retry status' }));
    expect(await screen.findByRole('button', { name: 'Enable Two-Factor Authentication' })).toBeEnabled();
  });

  it('keeps Authenticator App setup available while unresolved mail capability hides Email Code', async () => {
    mocks.publicSettings.current = null;
    mocks.twoFactorSetup.mockResolvedValue({
      method: 'totp',
      secret: 'ABCDEFGHIJKLMNOP',
      otpauthUrl: 'otpauth://totp/Portal:owner',
    });
    renderSettings('security');

    await userEvent.click(await screen.findByRole('button', { name: 'Enable Two-Factor Authentication' }));

    expect(screen.getByRole('status')).toHaveTextContent('Checking Email Code availability');
    expect(screen.queryByRole('button', { name: /Email Code/ })).not.toBeInTheDocument();
    const authenticator = screen.getByRole('button', { name: /Authenticator App/ });
    expect(authenticator).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: 'Retry availability check' }));
    expect(mocks.refreshPublicSettings).toHaveBeenCalledTimes(1);

    await userEvent.click(authenticator);
    expect(mocks.twoFactorSetup).toHaveBeenCalledTimes(1);
    expect(mocks.twoFactorSetup).toHaveBeenCalledWith('totp');
    expect(await screen.findByText('Scan QR Code')).toBeVisible();
  });

  it('explains unavailable Email Code setup without calling its endpoint', async () => {
    mocks.publicSettings.current = {
      originMode: 'tailnet',
      mail: {
        available: false,
        reason: 'Mail requires a public domain and is unavailable in private Tailnet mode.',
      },
    };
    renderSettings('security');

    await userEvent.click(await screen.findByRole('button', { name: 'Enable Two-Factor Authentication' }));

    expect(screen.getByText('Email Code is unavailable')).toBeVisible();
    expect(screen.getByText(/unavailable in private Tailnet mode/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Email Code/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Authenticator App/ })).toBeEnabled();
    expect(mocks.twoFactorSetup).not.toHaveBeenCalled();
  });

  it('uses an exact backup code to disable legacy Email Code in private mode without sending mail', async () => {
    mocks.publicSettings.current = {
      originMode: 'tailnet',
      mail: {
        available: false,
        reason: 'Mail requires a public domain and is unavailable in private Tailnet mode.',
      },
    };
    mocks.twoFactorStatus.mockImplementation(async () => (
      mocks.twoFactorDisable.mock.calls.length > 0
        ? { enabled: false, method: null, backupCodesRemaining: 0 }
        : { enabled: true, method: 'email', backupCodesRemaining: 3 }
    ));
    renderSettings('security');

    await screen.findByRole('button', { name: 'Disable 2FA' });
    expect(screen.getByText(/Email Code delivery is unavailable/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Regenerate Backup Codes' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Disable 2FA' }));

    expect(screen.queryByRole('button', { name: 'Send verification code' })).not.toBeInTheDocument();
    expect(screen.getByText(/remaining 8-character backup codes/i)).toBeVisible();
    const backupCode = screen.getByLabelText('Code to disable two-factor authentication');
    await userEvent.type(backupCode, 'aB3dE7xQ');
    expect(backupCode).toHaveValue('aB3dE7xQ');

    await userEvent.click(screen.getByRole('button', { name: 'Disable two-factor authentication' }));

    await waitFor(() => expect(mocks.twoFactorDisable).toHaveBeenCalledWith('aB3dE7xQ'));
    expect(mocks.twoFactorDisable).toHaveBeenCalledTimes(1);
    expect(mocks.twoFactorSendEmailAuthenticated).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Enable Two-Factor Authentication' })).toBeEnabled();
  });

  it('fails legacy Email Code changes closed while mail capability is unresolved', async () => {
    mocks.publicSettings.current = null;
    mocks.twoFactorStatus.mockResolvedValue({ enabled: true, method: 'email', backupCodesRemaining: 3 });
    renderSettings('security');

    expect(await screen.findByText(/Checking mail availability before allowing Email Code changes/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Disable 2FA' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Regenerate Backup Codes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send verification code' })).not.toBeInTheDocument();
    expect(mocks.twoFactorSendEmailAuthenticated).not.toHaveBeenCalled();
    expect(mocks.twoFactorDisable).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Retry availability check' }));
    expect(mocks.refreshPublicSettings).toHaveBeenCalledTimes(1);
  });

  it('routes zero-backup legacy Email Code users to Login recovery instead of an impossible disable form', async () => {
    mocks.publicSettings.current = {
      originMode: 'tailnet',
      mail: {
        available: false,
        reason: 'Mail requires a public domain and is unavailable in private Tailnet mode.',
      },
    };
    mocks.twoFactorStatus.mockResolvedValue({ enabled: true, method: 'email', backupCodesRemaining: 0 });
    renderSettings('security');

    expect(await screen.findByText(/No backup codes remain/)).toBeVisible();
    expect(screen.getByText(/sign in again with your password/i)).toBeVisible();
    expect(screen.getByText(/Email Code recovery option on the login screen/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Disable 2FA' })).toBeDisabled();
    expect(screen.queryByLabelText('Code to disable two-factor authentication')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send verification code' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Regenerate Backup Codes' })).not.toBeInTheDocument();
    expect(mocks.twoFactorDisable).not.toHaveBeenCalled();
    expect(mocks.twoFactorSendEmailAuthenticated).not.toHaveBeenCalled();
  });

  it('serializes setup method selection and snapshots a verification turn while blocking tab/cancel paths', async () => {
    const setup = deferred<{ method: 'email'; message: string }>();
    mocks.twoFactorSetup.mockReturnValueOnce(setup.promise);
    renderSettings('security');

    await userEvent.click(await screen.findByRole('button', { name: 'Enable Two-Factor Authentication' }));
    const emailMethod = screen.getByRole('button', { name: /Email Code/ });
    const totpMethod = screen.getByRole('button', { name: /Authenticator App/ });
    const profileTab = screen.getByRole('tab', { name: 'Profile' });

    act(() => {
      emailMethod.click();
      totpMethod.click();
      profileTab.click();
    });

    expect(mocks.twoFactorSetup).toHaveBeenCalledTimes(1);
    expect(mocks.twoFactorSetup).toHaveBeenCalledWith('email');
    expect(screen.getByRole('status')).toHaveTextContent('Starting email setup…');
    expect(profileTab).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await act(async () => {
      setup.resolve({ method: 'email', message: 'sent' });
      await setup.promise;
    });

    const code = await screen.findByLabelText('Email verification code');
    fireEvent.change(code, { target: { value: '123456' } });
    const verify = screen.getByRole('button', { name: 'Verify & Enable' });
    const verification = deferred<{ backupCodes: string[] }>();
    mocks.twoFactorVerifySetup.mockReturnValueOnce(verification.promise);

    act(() => {
      verify.click();
      fireEvent.change(code, { target: { value: '654321' } });
      verify.click();
      screen.getByRole('button', { name: 'Cancel setup' }).click();
    });

    expect(mocks.twoFactorVerifySetup).toHaveBeenCalledTimes(1);
    expect(mocks.twoFactorVerifySetup).toHaveBeenCalledWith('123456', 'email');
    expect(code).toHaveValue('123456');
    expect(screen.getByRole('button', { name: 'Enabling 2FA…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Cancel setup' })).toBeDisabled();
    expect(profileTab).toBeDisabled();

    await act(async () => {
      verification.reject({ response: { data: { error: 'That code expired' } } });
      await verification.promise.catch(() => undefined);
    });

    expect(await within(screen.getByRole('tabpanel')).findByRole('alert')).toHaveTextContent('That code expired');
    expect(screen.getByRole('button', { name: 'Verify & Enable' })).toBeEnabled();
    expect(profileTab).toBeEnabled();
  });

  it('keeps the 2FA working control authoritative until post-mutation status converges', async () => {
    renderSettings('security');
    await userEvent.click(await screen.findByRole('button', { name: 'Enable Two-Factor Authentication' }));
    await userEvent.click(screen.getByRole('button', { name: /Email Code/ }));
    const code = await screen.findByLabelText('Email verification code');
    fireEvent.change(code, { target: { value: '123456' } });
    const verification = deferred<{ backupCodes: string[] }>();
    const refreshedStatus = deferred<{ enabled: boolean; method: 'email'; backupCodesRemaining: number }>();
    mocks.twoFactorVerifySetup.mockReturnValueOnce(verification.promise);
    mocks.twoFactorStatus.mockReturnValueOnce(refreshedStatus.promise);

    await userEvent.click(screen.getByRole('button', { name: 'Verify & Enable' }));
    await act(async () => {
      verification.resolve({ backupCodes: ['backup-after-proof'] });
      await verification.promise;
    });
    expect(screen.getByRole('button', { name: 'Verifying enabled status…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('backup-after-proof')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Profile' })).toBeDisabled();

    await act(async () => {
      refreshedStatus.resolve({ enabled: true, method: 'email', backupCodesRemaining: 10 });
      await refreshedStatus.promise;
    });
    expect(await screen.findByText('backup-after-proof')).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Profile' })).toBeEnabled();
  });

  it('retries a rejected 2FA status readback without repeating accepted enablement', async () => {
    renderSettings('security');
    await userEvent.click(await screen.findByRole('button', { name: 'Enable Two-Factor Authentication' }));
    await userEvent.click(screen.getByRole('button', { name: /Email Code/ }));
    const code = await screen.findByLabelText('Email verification code');
    fireEvent.change(code, { target: { value: '123456' } });
    mocks.twoFactorStatus
      .mockRejectedValueOnce(new Error('readback offline'))
      .mockResolvedValue({ enabled: true, method: 'email', backupCodesRemaining: 1 });

    await userEvent.click(screen.getByRole('button', { name: 'Verify & Enable' }));

    expect(mocks.twoFactorVerifySetup).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('backup-1')).toBeVisible();
    expect(mocks.twoFactorVerifySetup).toHaveBeenCalledTimes(1);
    expect(mocks.twoFactorStatus.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('owns domain email disable as a retryable verification flow and hides unsupported regeneration', async () => {
    mocks.twoFactorStatus.mockResolvedValue({ enabled: true, method: 'email', backupCodesRemaining: 4 });
    renderSettings('security');

    const disableTrigger = await screen.findByRole('button', { name: 'Disable 2FA' });
    expect(screen.queryByRole('button', { name: 'Regenerate Backup Codes' })).not.toBeInTheDocument();
    await userEvent.click(disableTrigger);
    expect(screen.getByText('Confirm disable 2FA')).toBeVisible();
    expect(screen.queryByText('Regenerate backup codes')).not.toBeInTheDocument();

    const send = screen.getByRole('button', { name: 'Send verification code' });
    const pendingSend = deferred<{ message: string }>();
    mocks.twoFactorSendEmailAuthenticated.mockReturnValueOnce(pendingSend.promise);
    act(() => {
      send.click();
      send.click();
      screen.getByRole('button', { name: 'Cancel' }).click();
    });
    expect(mocks.twoFactorSendEmailAuthenticated).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Sending verification code…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await act(async () => {
      pendingSend.resolve({ message: 'sent' });
      await pendingSend.promise;
    });
    const disableCode = await screen.findByLabelText('Code to disable two-factor authentication');
    fireEvent.change(disableCode, { target: { value: '112233' } });
    const pendingDisable = deferred<{ success: boolean; message: string }>();
    mocks.twoFactorDisable.mockReturnValueOnce(pendingDisable.promise);
    const disable = screen.getByRole('button', { name: 'Disable two-factor authentication' });
    act(() => {
      disable.click();
      disable.click();
      fireEvent.change(disableCode, { target: { value: '998877' } });
    });
    expect(mocks.twoFactorDisable).toHaveBeenCalledTimes(1);
    expect(mocks.twoFactorDisable).toHaveBeenCalledWith('112233');
    expect(disableCode).toHaveValue('112233');
    await act(async () => {
      pendingDisable.reject({ response: { data: { error: 'Identity verification failed' } } });
      await pendingDisable.promise.catch(() => undefined);
    });
    expect(await within(screen.getByRole('tabpanel')).findByRole('alert')).toHaveTextContent('Identity verification failed');
    expect(screen.getByText('Confirm disable 2FA')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Regenerate Backup Codes' })).not.toBeInTheDocument();
  });

  it('keeps Authenticator App backup-code regeneration available and retryable', async () => {
    mocks.twoFactorStatus.mockResolvedValue({ enabled: true, method: 'totp', backupCodesRemaining: 4 });
    renderSettings('security');

    await screen.findByRole('button', { name: 'Disable 2FA' });
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate Backup Codes' }));
    const regenCode = await screen.findByLabelText('Code to regenerate backup codes');
    fireEvent.change(regenCode, { target: { value: '445566' } });
    const pendingRegen = deferred<{ backupCodes: string[] }>();
    mocks.twoFactorRegenerateBackupCodes.mockReturnValueOnce(pendingRegen.promise);
    const regenerate = screen.getByRole('button', { name: 'Regenerate backup codes' });
    act(() => {
      regenerate.click();
      regenerate.click();
    });
    expect(mocks.twoFactorRegenerateBackupCodes).toHaveBeenCalledTimes(1);
    expect(mocks.twoFactorRegenerateBackupCodes).toHaveBeenCalledWith('445566');
    await act(async () => {
      pendingRegen.reject({ response: { data: { error: 'Try a fresh code' } } });
      await pendingRegen.promise.catch(() => undefined);
    });
    expect(await within(screen.getByRole('tabpanel')).findByRole('alert')).toHaveTextContent('Try a fresh code');
    expect(screen.getByText('Regenerate backup codes')).toBeVisible();
    expect(mocks.twoFactorSendEmailAuthenticated).not.toHaveBeenCalled();
  });

  it('snapshots profile and password credentials and rejects cross-action same-frame submits', async () => {
    mocks.twoFactorStatus.mockResolvedValue({ enabled: true, method: 'email', backupCodesRemaining: 4 });
    renderSettings('profile');

    const username = await screen.findByLabelText('Username');
    const email = screen.getByLabelText('Email address');
    const profilePassword = screen.getByLabelText('Current password for profile changes');
    const token = screen.getByLabelText('Two-factor code for profile changes');
    fireEvent.change(username, { target: { value: 'renamed-owner' } });
    fireEvent.change(email, { target: { value: 'renamed@example.com' } });
    fireEvent.change(profilePassword, { target: { value: 'current-secret' } });
    fireEvent.change(token, { target: { value: '123456' } });

    const currentPassword = screen.getByLabelText('Current password');
    const newPassword = screen.getByLabelText('New password');
    const confirmPassword = screen.getByLabelText('Confirm new password');
    fireEvent.change(currentPassword, { target: { value: 'old-password' } });
    fireEvent.change(newPassword, { target: { value: 'NewPassword1' } });
    fireEvent.change(confirmPassword, { target: { value: 'NewPassword1' } });

    const pendingProfile = deferred<{ data: unknown }>();
    mocks.clientPut.mockReturnValueOnce(pendingProfile.promise);
    const save = screen.getByRole('button', { name: 'Save Changes' });
    const changePassword = screen.getByRole('button', { name: 'Change Password' });
    act(() => {
      save.click();
      save.click();
      fireEvent.change(username, { target: { value: 'late-change' } });
      changePassword.click();
      screen.getByRole('tab', { name: 'Security' }).click();
    });

    expect(mocks.clientPut).toHaveBeenCalledTimes(1);
    expect(mocks.clientPut).toHaveBeenCalledWith('/auth/me', {
      username: 'renamed-owner',
      email: 'renamed@example.com',
      currentPassword: 'current-secret',
      twoFactorToken: '123456',
    });
    expect(mocks.clientPost).not.toHaveBeenCalledWith('/auth/change-password', expect.anything());
    expect(username).toHaveValue('renamed-owner');
    expect(username).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'Security' })).toBeDisabled();

    await act(async () => {
      pendingProfile.reject({ response: { data: { error: 'Profile verification failed' } } });
      await pendingProfile.promise.catch(() => undefined);
    });
    expect(await within(screen.getByRole('tabpanel')).findByRole('alert')).toHaveTextContent('Profile verification failed');

    const pendingPassword = deferred<{ data: unknown }>();
    mocks.clientPost.mockReturnValueOnce(pendingPassword.promise);
    act(() => {
      changePassword.click();
      changePassword.click();
      fireEvent.change(newPassword, { target: { value: 'ChangedAgain1' } });
    });
    expect(mocks.clientPost).toHaveBeenCalledTimes(1);
    expect(mocks.clientPost).toHaveBeenCalledWith('/auth/change-password', {
      currentPassword: 'old-password',
      newPassword: 'NewPassword1',
    });
    expect(newPassword).toHaveValue('NewPassword1');
    expect(screen.getByRole('button', { name: 'Changing password…' })).toHaveAttribute('aria-busy', 'true');
    await act(async () => {
      pendingPassword.reject({ response: { data: { error: 'Password rejected' } } });
      await pendingPassword.promise.catch(() => undefined);
    });
    expect(await within(screen.getByRole('tabpanel')).findByText('Password rejected')).toHaveAttribute('role', 'alert');
  });

  it('locks profile identity changes when legacy Email Code cannot deliver and points to migration', async () => {
    mocks.publicSettings.current = {
      originMode: 'tailnet',
      mail: {
        available: false,
        reason: 'Mail requires a public domain and is unavailable in private Tailnet mode.',
      },
    };
    mocks.twoFactorStatus.mockResolvedValue({ enabled: true, method: 'email', backupCodesRemaining: 3 });
    renderSettings('profile');

    const panel = await screen.findByRole('tabpanel');
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Profile identity changes are temporarily unavailable',
    );
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'Use a remaining backup code in Two-Factor Authentication to disable Email Code',
    );
    expect(within(panel).getByLabelText('Username')).toBeDisabled();
    expect(within(panel).getByLabelText('Email address')).toBeDisabled();
    expect(within(panel).getByLabelText('Current password for profile changes')).toBeDisabled();
    expect(within(panel).getByLabelText('Two-factor code for profile changes')).toBeDisabled();
    expect(within(panel).queryByRole('button', { name: 'Send profile verification code' })).not.toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    expect(mocks.twoFactorSendEmailAuthenticated).not.toHaveBeenCalled();
    expect(mocks.clientPut).not.toHaveBeenCalledWith('/auth/me', expect.anything());

    // Password rotation remains available; only identity changes depend on email reauthentication.
    expect(within(panel).getByLabelText('Current password')).toBeEnabled();
    expect(within(panel).getByLabelText('New password')).toBeEnabled();
  });

  it('keeps profile identity controls locked until two-factor requirements are verified', async () => {
    mocks.twoFactorStatus.mockRejectedValueOnce(new Error('status offline'));
    renderSettings('profile');

    const panel = await screen.findByRole('tabpanel');
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Two-factor status could not be verified',
    );
    expect(within(panel).getByLabelText('Username')).toBeDisabled();
    expect(within(panel).getByLabelText('Email address')).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    expect(mocks.clientPut).not.toHaveBeenCalledWith('/auth/me', expect.anything());

    mocks.twoFactorStatus.mockResolvedValue({ enabled: true, method: 'totp', backupCodesRemaining: 3 });
    await userEvent.click(within(panel).getByRole('button', { name: 'Retry security check' }));

    await waitFor(() => expect(within(panel).getByLabelText('Username')).toBeEnabled());
    expect(within(panel).getByLabelText('Two-factor code for profile changes')).toBeEnabled();
    expect(within(panel).queryByRole('button', { name: 'Send profile verification code' })).not.toBeInTheDocument();
  });

  it('single-flights mail installation and test delivery and retains failures on each initiating surface', async () => {
    renderSettings('email');
    const install = await screen.findByRole('button', { name: 'Set Up Email Server' });
    const testEmail = screen.getByRole('button', { name: 'Send Test Email' });
    const pendingInstall = deferred<{ data: unknown }>();
    mocks.clientPost.mockReturnValueOnce(pendingInstall.promise);
    act(() => {
      install.click();
      install.click();
      testEmail.click();
      screen.getByRole('tab', { name: 'Profile' }).click();
    });
    expect(mocks.clientPost).toHaveBeenCalledTimes(1);
    expect(mocks.clientPost).toHaveBeenCalledWith('/admin/install-mail');
    expect(mocks.sendTestEmail).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Installing mail server/ })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('tab', { name: 'Profile' })).toBeDisabled();

    await act(async () => {
      pendingInstall.reject({ response: { data: { error: 'Package installation failed' } } });
      await pendingInstall.promise.catch(() => undefined);
    });
    expect(await within(screen.getByRole('tabpanel')).findByText('Package installation failed')).toBeVisible();

    const pendingTest = deferred<{ message: string }>();
    mocks.sendTestEmail.mockReturnValueOnce(pendingTest.promise);
    act(() => {
      testEmail.click();
      testEmail.click();
    });
    expect(mocks.sendTestEmail).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Sending test email…' })).toHaveAttribute('aria-busy', 'true');
    await act(async () => {
      pendingTest.reject({ response: { data: { error: 'SMTP refused the test' } } });
      await pendingTest.promise.catch(() => undefined);
    });
    expect(await within(screen.getByRole('tabpanel')).findByRole('alert')).toHaveTextContent('SMTP refused the test');
  });

  it('keeps unavailable mail discoverable while omitting every mail mutation and status surface', async () => {
    mocks.publicSettings.current = {
      originMode: 'tailnet',
      mail: {
        available: false,
        reason: 'Mail requires a public domain and is unavailable in private Tailnet mode.',
      },
    };

    renderSettings('email');

    const panel = await screen.findByRole('tabpanel');
    expect(screen.getByRole('tab', { name: 'Email — unavailable' })).toBeVisible();
    expect(within(panel).getByText('Mail requires a public domain')).toBeVisible();
    expect(within(panel).getByText(/unavailable in private Tailnet mode/i)).toBeVisible();
    expect(within(panel).getByRole('link', { name: 'Review domain settings' })).toHaveAttribute(
      'href',
      '/settings?tab=general',
    );
    expect(within(panel).queryByText('Email System Status')).not.toBeInTheDocument();
    expect(within(panel).queryByText('Notification Events')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Set Up Email Server' })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Send Test Email' })).not.toBeInTheDocument();
    expect(mocks.clientGet).not.toHaveBeenCalledWith('/admin/email-status', expect.anything());
    expect(mocks.clientPost).not.toHaveBeenCalledWith('/admin/install-mail');
    expect(mocks.sendTestEmail).not.toHaveBeenCalled();
  });

  it('does not probe or expose mail controls while capability truth is unresolved', async () => {
    mocks.publicSettings.current = null;

    renderSettings('email');

    const panel = await screen.findByRole('tabpanel');
    expect(within(panel).getByRole('status')).toHaveTextContent('Checking email availability');
    expect(within(panel).queryByRole('button', { name: 'Set Up Email Server' })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Send Test Email' })).not.toBeInTheDocument();
    expect(mocks.clientGet).not.toHaveBeenCalledWith('/admin/email-status', expect.anything());
  });

  it('does not discover or expose destructive mailbox management when mail is unavailable', async () => {
    mocks.publicSettings.current = {
      originMode: 'tailnet',
      mail: {
        available: false,
        reason: 'Mail requires a public domain and is unavailable in private Tailnet mode.',
      },
    };

    renderSettings('system');

    const panel = await screen.findByRole('tabpanel');
    expect(within(panel).getByText('Mailbox management requires a public domain')).toBeVisible();
    expect(within(panel).getByText(/unavailable in private Tailnet mode/i)).toBeVisible();
    expect(within(panel).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.clientGet).toHaveBeenCalledWith('/admin/coding-tools-status', { signal: undefined });
    });
    expect(mocks.clientGet.mock.calls.filter(([url]) => url === '/admin/mailboxes')).toHaveLength(0);
    expect(mocks.clientDelete).not.toHaveBeenCalled();
  });

  it('fails mailbox management closed and offers a capability retry while availability is unresolved', async () => {
    mocks.publicSettings.current = null;

    renderSettings('system');

    const panel = await screen.findByRole('tabpanel');
    expect(within(panel).getByRole('alert')).toHaveTextContent('Mailbox availability is not confirmed');
    expect(within(panel).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(mocks.clientGet.mock.calls.filter(([url]) => url === '/admin/mailboxes')).toHaveLength(0);

    await userEvent.click(within(panel).getByRole('button', { name: 'Retry availability check' }));
    expect(mocks.refreshPublicSettings).toHaveBeenCalledTimes(1);
  });

  it('preserves known mailbox rows and reports a refresh failure instead of claiming the list is empty', async () => {
    renderSettings('system');

    const panel = await screen.findByRole('tabpanel');
    expect(await within(panel).findByText('alice')).toBeVisible();
    mocks.clientGet.mockImplementation(async (url: string) => {
      if (url === '/admin/mailboxes') throw new Error('mailbox probe timed out');
      if (url === '/admin/coding-tools-status') return { data: { tools: [] } };
      return { data: {} };
    });

    await userEvent.click(within(panel).getByRole('button', { name: 'Refresh' }));

    expect(await within(panel).findByRole('alert')).toHaveTextContent('mailbox probe timed out');
    expect(within(panel).getByText('alice')).toBeVisible();
    expect(within(panel).queryByText('No mailboxes provisioned yet.')).not.toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Retry mailbox status' })).toBeEnabled();
  });

  it('serializes domain and search-visibility mutations with immutable rollback snapshots', async () => {
    renderSettings('general');
    const panel = await screen.findByRole('tabpanel');
    const domain = await within(panel).findByLabelText('Custom domain');

    const pendingDomain = deferred<{ data: unknown }>();
    mocks.clientPost.mockReturnValueOnce(pendingDomain.promise);
    const configure = within(panel).getByRole('button', { name: 'Configure domain' });
    await waitFor(() => expect(configure).toBeEnabled(), { timeout: 2_500 });
    fireEvent.change(domain, { target: { value: 'portal.example.com' } });
    const searchVisibility = within(panel).getByRole('switch', { name: 'Allow search engines to index this portal' });
    act(() => {
      configure.click();
      configure.click();
      fireEvent.change(domain, { target: { value: 'late.example.com' } });
      searchVisibility.click();
      screen.getByRole('tab', { name: 'Profile' }).click();
    });

    expect(mocks.clientPost).toHaveBeenCalledTimes(1);
    expect(mocks.clientPost).toHaveBeenCalledWith('/admin/configure-domain', { domain: 'portal.example.com' });
    expect(mocks.updateSearchVisibility).not.toHaveBeenCalled();
    expect(domain).toHaveValue('portal.example.com');
    expect(within(panel).getByRole('button', { name: 'Configuring...' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('tab', { name: 'Profile' })).toBeDisabled();

    await act(async () => {
      pendingDomain.reject({ response: { data: { error: 'Certificate issuance failed' } } });
      await pendingDomain.promise.catch(() => undefined);
    });
    expect(await within(panel).findByText('Certificate issuance failed')).toHaveAttribute('role', 'alert');

    const pendingVisibility = deferred<unknown>();
    mocks.updateSearchVisibility.mockReturnValueOnce(pendingVisibility.promise);
    act(() => {
      searchVisibility.click();
      searchVisibility.click();
      configure.click();
    });
    expect(mocks.updateSearchVisibility).toHaveBeenCalledTimes(1);
    expect(mocks.updateSearchVisibility).toHaveBeenCalledWith('visible');
    expect(mocks.clientPost).toHaveBeenCalledTimes(1);
    expect(searchVisibility).toHaveAttribute('aria-busy', 'true');
    await act(async () => {
      pendingVisibility.reject({ response: { data: { error: 'Robots policy update failed' } } });
      await pendingVisibility.promise.catch(() => undefined);
    });
    expect(searchVisibility).toHaveAttribute('aria-checked', 'false');
    expect(await within(panel).findByText('Robots policy update failed')).toHaveAttribute('role', 'alert');
  });

  it('single-flights shared settings saves and freezes the exact submitted draft until settlement', async () => {
    renderSettings('general');
    const panel = await screen.findByRole('tabpanel');
    const portalName = await within(panel).findByLabelText('Portal name');
    fireEvent.change(portalName, { target: { value: 'Renamed Portal' } });
    const save = within(panel).getByRole('button', { name: 'Save Changes' });
    const pendingSave = deferred<Record<string, string>>();
    mocks.updatePortalSettings.mockReturnValueOnce(pendingSave.promise);

    act(() => {
      save.click();
      save.click();
      fireEvent.change(portalName, { target: { value: 'Late Portal Name' } });
      screen.getByRole('tab', { name: 'Profile' }).click();
    });
    expect(mocks.updatePortalSettings).toHaveBeenCalledTimes(1);
    expect(mocks.updatePortalSettings).toHaveBeenCalledWith({
      'appearance.portalName': 'Renamed Portal',
      'appearance.assistantName': 'Assistant',
    });
    expect(portalName).toHaveValue('Renamed Portal');
    expect(within(panel).getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('tab', { name: 'Profile' })).toBeDisabled();

    await act(async () => {
      pendingSave.reject({ response: { data: { error: 'Settings revision conflict' } } });
      await pendingSave.promise.catch(() => undefined);
    });
    expect(await within(panel).findByText('Settings revision conflict')).toHaveAttribute('role', 'alert');
    expect(within(panel).getByRole('button', { name: 'Save Changes' })).toBeEnabled();
    expect(portalName).toBeEnabled();
  });

  it('blocks global links and browser Back while a Settings mutation owns the route', async () => {
    window.history.replaceState({}, '', '/before-settings');
    window.history.pushState({}, '', '/settings?tab=general');
    const pendingSave = deferred<Record<string, string>>();
    mocks.updatePortalSettings.mockReturnValueOnce(pendingSave.promise);
    render(
      <BrowserRouter>
        <Routes>
          <Route path="/settings" element={<><Link to="/outside">Leave Settings globally</Link><SettingsPage /></>} />
          <Route path="/before-settings" element={<div>Before Settings</div>} />
          <Route path="/outside" element={<div>Outside Settings</div>} />
        </Routes>
      </BrowserRouter>,
    );

    const portalName = await screen.findByLabelText('Portal name');
    fireEvent.change(portalName, { target: { value: 'Owned Settings' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-busy', 'true');

    fireEvent.click(screen.getByRole('link', { name: 'Leave Settings globally' }));
    expect(window.location.pathname).toBe('/settings');
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeVisible();

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await waitFor(() => expect(window.location.pathname).toBe('/settings'));
    expect(screen.queryByText('Before Settings')).not.toBeInTheDocument();

    await act(async () => {
      pendingSave.reject({ response: { data: { error: 'Synthetic release' } } });
      await pendingSave.promise.catch(() => undefined);
    });
    fireEvent.click(screen.getByRole('link', { name: 'Leave Settings globally' }));
    await screen.findByText('Outside Settings');
    expect(window.location.pathname).toBe('/outside');
  });

  it('blocks Logout-style shell actions outside Settings until the owning mutation settles', async () => {
    const outsidePointerAction = vi.fn();
    const outsideClickAction = vi.fn();
    const pendingSave = deferred<Record<string, string>>();
    mocks.updatePortalSettings.mockReturnValueOnce(pendingSave.promise);
    render(
      <MemoryRouter
        initialEntries={['/settings?tab=general']}
      >
        <button
          type="button"
          onPointerDown={outsidePointerAction}
          onClick={outsideClickAction}
        >
          Log out
        </button>
        <SettingsPage />
      </MemoryRouter>,
    );

    const portalName = await screen.findByLabelText('Portal name');
    fireEvent.change(portalName, { target: { value: 'Owned Settings' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-busy', 'true');

    const logout = screen.getByRole('button', { name: 'Log out' });
    fireEvent.pointerDown(logout);
    fireEvent.click(logout);
    expect(outsidePointerAction).not.toHaveBeenCalled();
    expect(outsideClickAction).not.toHaveBeenCalled();

    await act(async () => {
      pendingSave.reject({ response: { data: { error: 'Synthetic release' } } });
      await pendingSave.promise.catch(() => undefined);
    });
    expect(await within(screen.getByRole('tabpanel')).findByRole('alert')).toHaveTextContent('Synthetic release');

    fireEvent.pointerDown(logout);
    fireEvent.click(logout);
    expect(outsidePointerAction).toHaveBeenCalledTimes(1);
    expect(outsideClickAction).toHaveBeenCalledTimes(1);
  });

  it('single-flights the OpenClaw compaction mutation and blocks provider navigation until settlement', async () => {
    renderSettings('agents');
    const panel = await screen.findByRole('tabpanel');
    const toggle = await within(panel).findByRole('switch', { name: 'Show compaction notices in OpenClaw chats' });
    await waitFor(() => expect(toggle).toBeEnabled());
    const pendingPatch = deferred<unknown>();
    mocks.patchConfigPath.mockReturnValueOnce(pendingPatch.promise);

    act(() => {
      toggle.click();
      toggle.click();
      within(panel).getByRole('button', { name: 'Open AI Providers' }).click();
      screen.getByRole('tab', { name: 'Profile' }).click();
    });
    expect(mocks.patchConfigPath).toHaveBeenCalledTimes(1);
    expect(mocks.patchConfigPath).toHaveBeenCalledWith('agents.defaults.compaction.notifyUser', true);
    expect(toggle).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Profile' })).toBeDisabled();

    await act(async () => {
      pendingPatch.reject({ response: { data: { error: 'Gateway config CAS failed' } } });
      await pendingPatch.promise.catch(() => undefined);
    });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(await within(panel).findByText('Gateway config CAS failed')).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('tab', { name: 'Profile' })).toBeEnabled();
  });

  it('mounts one canonical Remote GPU surface and keeps local CPU policy compact without legacy model APIs', async () => {
    renderSettings('ai-providers');
    const panel = await screen.findByRole('tabpanel');
    expect(await within(panel).findByText('Remote GPU management')).toBeVisible();
    expect(within(panel).queryByText('Local Models (Ollama)')).not.toBeInTheDocument();
    expect(within(panel).queryByLabelText('Ollama model to pull')).not.toBeInTheDocument();
    expect(within(panel).queryByLabelText('Remote Ollama host URL')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Test Connection' })).not.toBeInTheDocument();
    expect(mocks.clientGet).not.toHaveBeenCalledWith('/ollama/models');
    expect(mocks.clientGet).not.toHaveBeenCalledWith('/ollama/pulls');
    expect(mocks.clientGet).not.toHaveBeenCalledWith('/ollama/recommendations');
    expect(mocks.clientPost).not.toHaveBeenCalledWith(
      '/ollama/test-connection',
      expect.anything(),
    );
    expect(mocks.clientPost).not.toHaveBeenCalledWith(
      '/ollama/pull',
      expect.anything(),
    );

    await userEvent.click(within(panel).getByText('Local CPU preferences'));
    expect(within(panel).getByRole('switch', {
      name: 'Enable local CPU runtime',
    })).toBeVisible();
    expect(within(panel).getByLabelText('Default local CPU model')).toBeVisible();
    expect(within(panel).getByLabelText('Snappy local model')).toBeVisible();
    expect(within(panel).getByText(/do not inspect, merge with, download to, or silently replace/i))
      .toBeVisible();

    await userEvent.click(within(panel).getByRole('switch', {
      name: 'Enable local CPU runtime',
    }));
    fireEvent.change(within(panel).getByLabelText('Default local CPU model'), {
      target: { value: 'local-only:latest' },
    });
    await userEvent.click(within(panel).getByRole('button', {
      name: 'Save Changes',
    }));
    await waitFor(() => {
      expect(mocks.updatePortalSettings).toHaveBeenCalledWith({
        'ollama.localEnabled': 'false',
        'ollama.defaultModel': 'local-only:latest',
        'ollama.local.tier.snappy': 'qwen3.5:2b',
        'ollama.local.tier.smart': 'qwen3.5:4b',
        'ollama.local.tier.best': 'qwen3.5:9b',
      });
    });
  });

  it('locks only the local-runtime switch under native authority, saves model preferences, and refreshes restored policy without replacing drafts', async () => {
    mocks.getPortalSettings
      .mockResolvedValueOnce({
        'ollama.localEnabled': 'true',
        'ollama.defaultModel': 'qwen3.5:4b',
        'ollama.local.tier.snappy': 'qwen3.5:2b',
        'ollama.local.tier.smart': 'qwen3.5:4b',
        'ollama.local.tier.best': 'qwen3.5:9b',
      })
      .mockResolvedValueOnce({
        'ollama.localEnabled': 'false',
        'ollama.defaultModel': 'server-connected:latest',
        'ollama.local.tier.snappy': 'qwen3.5:2b',
        'ollama.local.tier.smart': 'qwen3.5:4b',
        'ollama.local.tier.best': 'qwen3.5:9b',
      })
      .mockResolvedValueOnce({
        'ollama.localEnabled': 'true',
        'ollama.defaultModel': 'server-restored:latest',
        'ollama.local.tier.snappy': 'qwen3.5:2b',
        'ollama.local.tier.smart': 'qwen3.5:4b',
        'ollama.local.tier.best': 'qwen3.5:9b',
      });

    renderSettings('ai-providers');
    const panel = await screen.findByRole('tabpanel');
    await userEvent.click(within(panel).getByText('Local CPU preferences'));

    const localToggle = within(panel).getByRole('switch', {
      name: 'Enable local CPU runtime',
    });
    const defaultModel = within(panel).getByLabelText(
      'Default local CPU model',
    );
    expect(localToggle).toBeEnabled();
    expect(localToggle).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(localToggle);
    fireEvent.change(defaultModel, {
      target: { value: 'draft-before-connect:latest' },
    });
    await userEvent.click(within(panel).getByRole('button', {
      name: 'Complete Remote GPU setup',
    }));

    await waitFor(() => {
      expect(mocks.getPortalSettings).toHaveBeenCalledTimes(2);
      expect(localToggle).toBeDisabled();
      expect(localToggle).toHaveAttribute('aria-checked', 'false');
    });
    expect(within(panel).getByText(
      /Remote GPU currently owns Ollama execution/i,
    )).toBeVisible();
    expect(defaultModel).toHaveValue('draft-before-connect:latest');

    fireEvent.change(within(panel).getByLabelText('Smart local model'), {
      target: { value: 'draft-smart:latest' },
    });
    await userEvent.click(within(panel).getByRole('button', {
      name: 'Save Changes',
    }));
    await waitFor(() => {
      expect(mocks.updatePortalSettings).toHaveBeenCalledWith({
        'ollama.defaultModel': 'draft-before-connect:latest',
        'ollama.local.tier.snappy': 'qwen3.5:2b',
        'ollama.local.tier.smart': 'draft-smart:latest',
        'ollama.local.tier.best': 'qwen3.5:9b',
      });
    });
    expect(mocks.updatePortalSettings.mock.calls[0]?.[0])
      .not.toHaveProperty('ollama.localEnabled');

    const bestModel = within(panel).getByLabelText('Best local model');
    fireEvent.change(bestModel, {
      target: { value: 'draft-before-remove:latest' },
    });
    await userEvent.click(within(panel).getByRole('button', {
      name: 'Remove Remote GPU',
    }));

    await waitFor(() => {
      expect(mocks.getPortalSettings).toHaveBeenCalledTimes(3);
      expect(localToggle).toBeEnabled();
      expect(localToggle).toHaveAttribute('aria-checked', 'true');
    });
    expect(bestModel).toHaveValue('draft-before-remove:latest');
  });

  it('uses the global Settings mutation coordinator for the unified Remote GPU panel', async () => {
    const pendingMutation = deferred<void>();
    mocks.remotePanelMutation.mockReturnValueOnce(pendingMutation.promise);
    renderSettings('ai-providers');
    const panel = await screen.findByRole('tabpanel');
    const start = await within(panel).findByRole('button', {
      name: 'Start Remote GPU mutation',
    });

    act(() => {
      start.click();
      start.click();
      screen.getByRole('tab', { name: 'Profile' }).click();
    });

    expect(mocks.remotePanelMutation).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('tab', { name: 'Profile' })).toBeDisabled();
    expect(within(panel).getByText('Local CPU preferences').closest('fieldset'))
      .toBeDisabled();

    await act(async () => {
      pendingMutation.resolve();
      await pendingMutation.promise;
    });
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Profile' })).toBeEnabled();
    });
  });

  it('consumes the persisted setup handoff after the native Remote GPU becomes authoritative', async () => {
    renderSettings('ai-providers', '&setup=complete&ollama=tailnet');
    expect(await screen.findByText('Portal launched. Now connect the Remote GPU.')).toBeVisible();
    expect(screen.getByText(/run the one-time setup/i)).toBeVisible();
    const setupSurface = screen.getByText('Remote GPU management').closest('div');
    expect(setupSurface?.className).toContain('ring-2');

    await userEvent.click(screen.getByRole('button', { name: 'Complete Remote GPU setup' }));

    await waitFor(() => {
      expect(screen.queryByText('Portal launched. Now connect the Remote GPU.'))
        .not.toBeInTheDocument();
      expect(screen.getByText('Remote GPU management').closest('div')?.className)
        .not.toContain('ring-2');
    });
  });

  it('keeps host-tool, mailbox, and hotfix confirmations exclusive, retryable, and immutable', async () => {
    renderSettings('system');
    const installTrigger = await screen.findByRole('button', { name: 'Install' });
    const deleteTrigger = screen.getByRole('button', { name: 'Delete' });
    act(() => {
      installTrigger.click();
      deleteTrigger.click();
    });
    let dialog = await screen.findByRole('dialog', { name: 'Install Codex CLI?' });
    expect(screen.queryByRole('dialog', { name: /Delete mailbox/ })).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole('textbox'), 'INSTALL CODEX');
    const pendingInstall = deferred<{ data: unknown }>();
    mocks.clientPost.mockReturnValueOnce(pendingInstall.promise);
    const confirmInstall = within(dialog).getByRole('button', { name: 'Install host tool' });
    act(() => {
      confirmInstall.click();
      confirmInstall.click();
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(mocks.clientPost).toHaveBeenCalledTimes(1);
    expect(mocks.clientPost).toHaveBeenCalledWith('/admin/install-coding-tool', { toolId: 'codex', confirmation: 'INSTALL CODEX' });
    expect(within(dialog).getByRole('button', { name: 'Installing host tool…' })).toHaveAttribute('aria-busy', 'true');
    await act(async () => {
      pendingInstall.reject({ response: { data: { error: 'Package manager busy' } } });
      await pendingInstall.promise.catch(() => undefined);
    });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Package manager busy');
    expect(dialog).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    dialog = await screen.findByRole('dialog', { name: 'Delete mailbox alice?' });
    await userEvent.type(within(dialog).getByRole('textbox'), 'DELETE MAILBOX alice');
    const pendingDelete = deferred<{ data: unknown }>();
    mocks.clientDelete.mockReturnValueOnce(pendingDelete.promise);
    const confirmDelete = within(dialog).getByRole('button', { name: 'Delete mailbox' });
    act(() => {
      confirmDelete.click();
      confirmDelete.click();
    });
    expect(mocks.clientDelete).toHaveBeenCalledTimes(1);
    expect(mocks.clientDelete).toHaveBeenCalledWith('/admin/mailboxes/alice', { data: { confirmation: 'DELETE MAILBOX alice' } });
    await act(async () => {
      pendingDelete.reject({ response: { data: { error: 'Mailbox still locked' } } });
      await pendingDelete.promise.catch(() => undefined);
    });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Mailbox still locked');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await userEvent.click(screen.getByRole('button', { name: /Apply compatibility patches and restart/ }));
    dialog = await screen.findByRole('dialog', { name: 'Apply OpenClaw compatibility hotfix?' });
    await userEvent.type(within(dialog).getByRole('textbox'), 'APPLY OPENCLAW HOTFIX');
    const pendingHotfix = deferred<any>();
    mocks.applyCompatibilityHotfix.mockReturnValueOnce(pendingHotfix.promise);
    const confirmHotfix = within(dialog).getByRole('button', { name: 'Apply hotfix + restart' });
    act(() => {
      confirmHotfix.click();
      confirmHotfix.click();
    });
    expect(mocks.applyCompatibilityHotfix).toHaveBeenCalledTimes(1);
    expect(mocks.applyCompatibilityHotfix).toHaveBeenCalledWith('APPLY OPENCLAW HOTFIX');
    await act(async () => {
      pendingHotfix.reject({ response: { data: { detail: 'Gateway restart was refused' } } });
      await pendingHotfix.promise.catch(() => undefined);
    });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Gateway restart was refused');
    expect(dialog).toBeVisible();
  });
});
