// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://portal.example.com/setup?step=5"}
import '../test/setup';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SetupWizardPage from './SetupWizardPage';
import { SETUP_SESSION_STORAGE_KEY } from './setupWizardFlow';

const setupMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  interceptorUse: vi.fn(() => 1),
  interceptorEject: vi.fn(),
  restoreSession: vi.fn(),
  refreshPublicSettings: vi.fn(),
}));

vi.mock('../api/client', () => ({
  default: {
    get: setupMocks.get,
    post: setupMocks.post,
    interceptors: {
      request: {
        use: setupMocks.interceptorUse,
        eject: setupMocks.interceptorEject,
      },
    },
  },
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuthStore: () => ({ restoreSession: setupMocks.restoreSession }),
}));

vi.mock('../components/ai-setup/AiProviderSetup', () => ({
  default: () => <button type="button">Connect provider</button>,
}));

vi.mock('../utils/sounds', () => ({
  sounds: { click: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock('../hooks/usePublicSettings', () => ({
  refreshPublicSettings: setupMocks.refreshPublicSettings,
}));

const SESSION_TOKEN = 'setup_session_abcdefghijklmnopqrstuvwxyz1234567890';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const systemInfo = {
  publicIp: '203.0.113.8',
  ramGb: 32,
  diskGb: 200,
  cpus: 8,
  osName: 'Test Linux',
  installProfile: 'server',
  components: {},
};

const tailnetSystemInfo = {
  ...systemInfo,
  currentDomain: '',
  originMode: 'tailnet',
  featureCapabilities: {
    originMode: 'tailnet',
    experimental: true,
    privateNetworkOnly: true,
    mail: {
      available: false,
      reason: 'Mail requires a public domain and is unavailable in experimental private Tailnet mode.',
    },
    appHosting: {
      available: false,
      reason: 'Hosted apps and share links require a separate public app-content origin and are unavailable in experimental private Tailnet mode.',
    },
  },
};

const mailStatus = {
  available: true,
  configured: true,
  canSend: true,
  dkimConfigured: true,
  dnsRecords: [],
  domain: 'portal.example.com',
  hasDomain: true,
};

const ollamaStatus = {
  running: true,
  endpoint: 'http://127.0.0.1:11434',
  models: [],
  ramGb: 32,
  availableRamGb: 24,
  reservedHeadroomGb: 4,
  ramTier: 'high',
  warning: null,
  recommendedModels: [{
    name: 'test-model:latest',
    description: 'A test model',
    size: '1 GB',
    minAvailableRamGb: 4,
    contextWindow: '32K',
    useCase: 'general',
    sourceUrl: 'https://ollama.com/library/test-model',
  }],
};

const openClawStatus = {
  installed: true,
  version: '2026.7.1',
  corePackageVersion: '2026.7.1',
  runningVersion: '2026.7.1',
  gatewayRunning: true,
  authenticatedRpc: false,
  gatewayUrl: 'http://127.0.0.1:18789',
  hasToken: true,
  tokenParity: true,
  codexPluginVersion: '2026.7.1',
  codexPluginInstallSpec: null,
  credentialStoreReady: false,
  credentialStoreWritable: false,
  testedCorePackageVersion: '2026.7.1',
  testedRuntimeVersion: '2026.7.1',
  testedCodexPluginVersion: '2026.7.1',
  testedPairReady: false,
  ready: false,
  blockers: [],
  description: 'OpenClaw is installed.',
};

function installGetMocks(
  isReinstall = false,
  tailnetOnboardingPhase: 'NOT_REQUESTED' | 'REQUESTED' | 'COMPLETED' = 'NOT_REQUESTED',
) {
  setupMocks.get.mockImplementation(async (url: string) => {
    if (url === '/setup/status') {
      return {
        data: {
          setupTransport: { allowed: true, transport: 'https' },
          needsSetup: true,
          isReinstall,
          ownerHint: isReinstall ? 'owner@example.com' : undefined,
          tailnetOnboarding: { phase: tailnetOnboardingPhase },
        },
      };
    }
    if (url === '/setup/system-info') return { data: systemInfo };
    if (url === '/setup/mail-status') return { data: mailStatus };
    if (url === '/setup/mail-preflight') {
      return { data: { provider: 'test', providerName: 'Test VPS', dockerOk: true, port25Open: true, smtpBlocked: false, providerInstructions: null, providerLink: null, canSelfHost: true } };
    }
    if (url === '/setup/ollama-status') return { data: ollamaStatus };
    if (url === '/setup/openclaw-status') return { data: openClawStatus };
    if (url === '/setup/coding-tools-status') {
      return { data: { tools: [{ id: 'codex', name: 'Codex CLI', description: 'Codex command line', installed: false, version: '', installCmd: 'npm i codex' }] } };
    }
    throw new Error(`Unexpected GET ${url}`);
  });
}

function installTailnetGetMocks() {
  setupMocks.get.mockImplementation(async (url: string) => {
    if (url === '/setup/status') {
      return {
        data: {
          setupTransport: { allowed: true, transport: 'https' },
          needsSetup: true,
          isReinstall: false,
          tailnetOnboarding: { phase: 'NOT_REQUESTED' },
        },
      };
    }
    if (url === '/setup/system-info') return { data: tailnetSystemInfo };
    throw new Error(`Tailnet setup made an unsupported GET ${url}`);
  });
}

function renderWizard(step: number, quickSetup = false) {
  const mode = quickSetup ? '&mode=quick' : '';
  window.history.replaceState({}, '', `https://portal.example.com/setup?step=${step}${mode}`);
  return render(
    <MemoryRouter>
      <SetupWizardPage />
    </MemoryRouter>,
  );
}

describe('SetupWizardPage mutation ownership', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.sessionStorage.setItem(SETUP_SESSION_STORAGE_KEY, SESSION_TOKEN);
    setupMocks.get.mockReset();
    setupMocks.post.mockReset();
    setupMocks.interceptorUse.mockClear();
    setupMocks.interceptorEject.mockClear();
    setupMocks.restoreSession.mockReset().mockResolvedValue(false);
    setupMocks.refreshPublicSettings.mockReset().mockResolvedValue(undefined);
    vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    installGetMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('single-flights email installation, rejects a same-frame test send and navigation, then supports retry', async () => {
    const firstInstall = deferred<{ data: { success: boolean; domain: string; dnsRecords: []; message: string } }>();
    let installAttempts = 0;
    setupMocks.post.mockImplementation((url: string) => {
      if (url === '/setup/install-mail') {
        installAttempts += 1;
        if (installAttempts === 1) return firstInstall.promise;
        return Promise.resolve({ data: { success: true, domain: 'portal.example.com', dnsRecords: [], message: 'Email is ready.' } });
      }
      if (url === '/setup/test-email') return Promise.resolve({ data: { success: true, message: 'Sent.' } });
      throw new Error(`Unexpected POST ${url}`);
    });

    renderWizard(5);
    const install = await screen.findByRole('button', { name: 'Set Up Email' });
    const testEmail = screen.getByRole('button', { name: 'Send Test Email' });
    const back = screen.getByRole('button', { name: 'Back' });
    const skip = screen.getByRole('button', { name: /Skip for now/i });

    act(() => {
      install.click();
      install.click();
      testEmail.click();
      back.click();
      skip.click();
    });

    expect(setupMocks.post).toHaveBeenCalledTimes(1);
    expect(setupMocks.post).toHaveBeenCalledWith('/setup/install-mail');
    expect(await screen.findByRole('button', { name: 'Setting up email…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Skip for now/i })).toBeDisabled();
    expect(screen.getByRole('heading', { name: 'Secure Your Portal' })).toBeVisible();
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false);

    await act(async () => {
      firstInstall.reject(new Error('Mail image pull failed.'));
      await Promise.resolve();
    });

    expect(await screen.findByText('Mail image pull failed.')).toBeVisible();
    const retry = screen.getByRole('button', { name: 'Retry email setup' });
    expect(retry).toBeEnabled();
    await userEvent.click(retry);
    expect(await screen.findByText('Email is ready.')).toBeVisible();
    expect(setupMocks.post).toHaveBeenCalledTimes(2);
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: /Skip for now/i }));
    expect(await screen.findByRole('heading', { name: 'AI setup' })).toBeVisible();
  });

  it('presents Tailnet HTTPS as experimental private access, not a configured public domain', async () => {
    installTailnetGetMocks();
    renderWizard(1);

    expect(await screen.findByRole('heading', { name: 'Private Tailnet access' })).toBeVisible();
    expect(screen.getByText('Experimental private mode')).toBeVisible();
    expect(screen.getByText('https://portal.example.com')).toBeVisible();
    expect(screen.getByText(/Only devices joined to this same tailnet/i)).toBeVisible();
    expect(screen.queryByText('Your domain is already configured.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Configure HTTPS' })).not.toBeInTheDocument();
  });

  it('does not probe or mutate mail when the setup capability is unavailable', async () => {
    installTailnetGetMocks();
    renderWizard(5);

    expect(await screen.findByText('Mail is unavailable in this install mode')).toBeVisible();
    expect(screen.getByText(/Mail requires a public domain and is unavailable/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Set Up Email' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send Test Email' })).not.toBeInTheDocument();
    await waitFor(() => expect(setupMocks.get).toHaveBeenCalledWith('/setup/system-info'));
    expect(setupMocks.get.mock.calls.map(([url]) => url)).not.toContain('/setup/mail-status');
    expect(setupMocks.get.mock.calls.map(([url]) => url)).not.toContain('/setup/mail-preflight');
    expect(setupMocks.post).not.toHaveBeenCalled();
  });

  it('reviews Tailnet and unavailable mail honestly before launch', async () => {
    installTailnetGetMocks();
    renderWizard(8);

    expect(await screen.findByText('Private Tailnet (experimental)')).toBeVisible();
    expect(screen.getByText('https://portal.example.com')).toBeVisible();
    expect(screen.getByText('Unavailable')).toBeVisible();
    expect(screen.getByText(/Mail requires a public domain and is unavailable/i)).toBeVisible();
    expect(screen.queryByText('Not configured (HTTP)')).not.toBeInTheDocument();
  });

  it('keeps BrowserRouter on Setup when Back is pressed during a live installer', async () => {
    const install = deferred<{ data: { success: boolean; domain: string; dnsRecords: []; message: string } }>();
    setupMocks.post.mockImplementation((url: string) => {
      if (url === '/setup/install-mail') return install.promise;
      throw new Error(`Unexpected POST ${url}`);
    });

    window.history.replaceState({}, '', 'https://portal.example.com/outside');
    window.history.pushState({}, '', 'https://portal.example.com/setup?step=5');
    render(
      <BrowserRouter>
        <Routes>
          <Route path="/setup" element={<SetupWizardPage />} />
          <Route path="/outside" element={<div>Outside setup</div>} />
        </Routes>
      </BrowserRouter>,
    );

    const installButton = await screen.findByRole('button', { name: 'Set Up Email' });
    act(() => {
      installButton.click();
      installButton.click();
    });
    expect(setupMocks.post).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Setting up email…' })).toBeDisabled();

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(window.location.pathname).toBe('/setup'));
    expect(screen.queryByText('Outside setup')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Secure Your Portal' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Setting up email…' })).toBeDisabled();
    expect(setupMocks.post).toHaveBeenCalledTimes(1);

    await act(async () => {
      install.resolve({ data: { success: true, domain: 'portal.example.com', dnsRecords: [], message: 'Email is ready.' } });
      await Promise.resolve();
    });
    expect(await screen.findByRole('button', { name: 'Set Up Email' })).toBeEnabled();
  });

  it('single-flights test-email delivery and keeps its retry on the email step', async () => {
    const firstSend = deferred<{ data: { success: boolean; message: string } }>();
    let attempts = 0;
    setupMocks.post.mockImplementation((url: string) => {
      if (url === '/setup/test-email') {
        attempts += 1;
        if (attempts === 1) return firstSend.promise;
        return Promise.resolve({ data: { success: true, message: 'Test email delivered.' } });
      }
      if (url === '/setup/install-mail') return Promise.resolve({ data: { success: true, domain: 'portal.example.com', dnsRecords: [], message: 'Ready.' } });
      throw new Error(`Unexpected POST ${url}`);
    });

    renderWizard(2);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Full name'), 'Portal Owner');
    await user.type(screen.getByLabelText('Email address'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'ValidPass1');
    await user.type(screen.getByLabelText('Confirm password'), 'ValidPass1');
    await user.click(screen.getByRole('button', { name: /^Next/i }));
    await user.click(await screen.findByRole('button', { name: /Skip for now/i }));
    await user.click(await screen.findByRole('button', { name: /Skip for now/i }));
    const send = await screen.findByRole('button', { name: 'Send Test Email' });
    act(() => {
      send.click();
      send.click();
      screen.getByRole('button', { name: 'Set Up Email' }).click();
      screen.getByRole('button', { name: /Skip for now/i }).click();
    });

    expect(setupMocks.post).toHaveBeenCalledTimes(1);
    expect(setupMocks.post).toHaveBeenCalledWith('/setup/test-email', { email: 'owner@example.com' });
    expect(await screen.findByRole('button', { name: 'Sending test email…' })).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      firstSend.reject(new Error('Email route unavailable.'));
      await Promise.resolve();
    });
    expect(await screen.findByText('Email route unavailable.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Retry test email' }));
    expect(await screen.findByText('Test email delivered.')).toBeVisible();
    expect(attempts).toBe(2);
  });

  it('keeps one stable Remote Desktop setup owner and blocks Back/Skip until retry settles', async () => {
    const firstSetup = deferred<{ data: { ok: boolean; message: string; steps: [] } }>();
    let attempts = 0;
    setupMocks.post.mockImplementation((url: string) => {
      if (url !== '/setup/install-rd') throw new Error(`Unexpected POST ${url}`);
      attempts += 1;
      if (attempts === 1) return firstSetup.promise;
      return Promise.resolve({ data: { ok: true, message: 'Remote Desktop is ready.', steps: [] } });
    });

    renderWizard(7);
    const setup = await screen.findByRole('button', { name: 'Set Up Remote Desktop' });
    const back = screen.getByRole('button', { name: 'Back' });
    const skip = screen.getByRole('button', { name: /Skip for now/i });

    act(() => {
      setup.click();
      setup.click();
      back.click();
      skip.click();
    });

    expect(setupMocks.post).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Setting up Remote Desktop…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('heading', { name: 'Remote Desktop' })).toBeVisible();

    await act(async () => {
      firstSetup.reject(new Error('Package manager was busy.'));
      await Promise.resolve();
    });

    expect(await screen.findByText('Package manager was busy.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Retry Remote Desktop Setup' }));
    expect(await screen.findByText('Remote Desktop is ready.')).toBeVisible();
    expect(setupMocks.post).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
  });

  it('serializes coding-tool installs and model pulls through one wizard owner with retryable errors', async () => {
    const firstToolInstall = deferred<{ data: { ok: boolean } }>();
    const firstModelPull = deferred<{ data: { ok: boolean } }>();
    let toolAttempts = 0;
    let modelAttempts = 0;
    setupMocks.post.mockImplementation((url: string) => {
      if (url === '/setup/install-coding-tool') {
        toolAttempts += 1;
        if (toolAttempts === 1) return firstToolInstall.promise;
        return Promise.resolve({ data: { ok: true } });
      }
      if (url === '/setup/ollama-pull') {
        modelAttempts += 1;
        if (modelAttempts === 1) return firstModelPull.promise;
        return Promise.resolve({ data: { ok: true } });
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    renderWizard(6);
    const install = await screen.findByRole('button', { name: 'Install' });
    const pull = await screen.findByRole('button', { name: 'Pull' });
    const back = screen.getByRole('button', { name: 'Back' });

    act(() => {
      install.click();
      install.click();
      pull.click();
      back.click();
    });

    expect(setupMocks.post).toHaveBeenCalledTimes(1);
    expect(setupMocks.post).toHaveBeenCalledWith('/setup/install-coding-tool', { toolId: 'codex' });
    expect(await screen.findByRole('button', { name: 'Installing…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('heading', { name: 'AI setup' })).toBeVisible();

    await act(async () => {
      firstToolInstall.reject(new Error('Tool install failed.'));
      await Promise.resolve();
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Tool install failed.');
    await userEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(toolAttempts).toBe(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pull' })).toBeEnabled());

    const pullAfterRetry = screen.getByRole('button', { name: 'Pull' });
    act(() => {
      pullAfterRetry.click();
      pullAfterRetry.click();
      screen.getByRole('button', { name: 'Install' }).click();
      screen.getByRole('button', { name: /Skip for now/i }).click();
    });

    expect(modelAttempts).toBe(1);
    expect(setupMocks.post).toHaveBeenLastCalledWith('/setup/ollama-pull', { model: 'test-model:latest' });
    expect(await screen.findByRole('button', { name: 'Pulling…' })).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      firstModelPull.reject(new Error('Model pull failed.'));
      await Promise.resolve();
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Model pull failed.');
    await userEvent.click(screen.getByRole('button', { name: 'Pull' }));
    await waitFor(() => expect(modelAttempts).toBe(2));
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
  });

  it('persists and resumes the native Remote GPU handoff through review', async () => {
    installGetMocks(false, 'REQUESTED');
    setupMocks.post.mockImplementation((url: string, body?: unknown) => {
      if (url === '/setup/tailnet-onboarding') {
        return Promise.resolve({ data: { phase: 'NOT_REQUESTED' } });
      }
      if (url === '/setup/complete') {
        return Promise.reject(Object.assign(new Error('Stop after snapshot.'), {
          response: { status: 422 },
        }));
      }
      throw new Error(`Unexpected POST ${url} ${JSON.stringify(body)}`);
    });

    renderWizard(6);
    expect(await screen.findByRole('button', {
      name: 'Remote GPU queued after launch',
    })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/one private, identity-bound Tailscale Serve rule/i))
      .toBeVisible();
    expect(screen.getByText(/never asks for a raw Ollama URL or browser secret/i))
      .toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: /Skip for now/i }));
    await userEvent.click(await screen.findByRole('button', { name: /Skip for now/i }));
    expect(await screen.findByText('Remote GPU: Setup queued after launch')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    const queued = await screen.findByRole('button', {
      name: 'Remote GPU queued after launch',
    });
    await userEvent.click(queued);
    expect(setupMocks.post).toHaveBeenCalledWith('/setup/tailnet-onboarding', {
      requested: false,
    });
    expect(await screen.findByRole('button', { name: 'Connect after launch' }))
      .toHaveAttribute('aria-pressed', 'false');
  });

  it('includes the resumed Tailnet GPU handoff in the atomic completion snapshot', async () => {
    installGetMocks(false, 'REQUESTED');
    setupMocks.post.mockImplementation((url: string) => {
      if (url !== '/setup/complete') throw new Error(`Unexpected POST ${url}`);
      return Promise.reject(Object.assign(new Error('Snapshot accepted by test.'), {
        response: { status: 422 },
      }));
    });

    renderWizard(2, true);
    await userEvent.type(await screen.findByLabelText('Full name'), 'Portal Owner');
    await userEvent.type(screen.getByLabelText('Email address'), 'owner@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'ValidPass1');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'ValidPass1');
    await userEvent.click(screen.getByRole('button', { name: 'Launch Portal' }));

    expect(setupMocks.post).toHaveBeenCalledWith(
      '/setup/complete',
      expect.objectContaining({
        email: 'owner@example.com',
        allowTelemetry: true,
        tailnetRequested: true,
      }),
      { timeout: 30_000 },
    );
  });

  it('snapshots completion, suppresses same-frame launch/navigation, and keeps failure retryable on the owner step', async () => {
    const firstComplete = deferred<{ data: { success: boolean } }>();
    let attempts = 0;
    setupMocks.post.mockImplementation((url: string) => {
      if (url !== '/setup/complete') throw new Error(`Unexpected POST ${url}`);
      attempts += 1;
      if (attempts === 1) return firstComplete.promise;
      return Promise.reject(Object.assign(new Error('Retry remains on this step.'), { response: { status: 422 } }));
    });
    renderWizard(2, true);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Full name'), 'Portal Owner');
    await user.type(screen.getByLabelText('Email address'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'ValidPass1');
    await user.type(screen.getByLabelText('Confirm password'), 'ValidPass1');

    const launch = screen.getByRole('button', { name: 'Launch Portal' });
    const back = screen.getByRole('button', { name: 'Back' });
    act(() => {
      launch.click();
      launch.click();
      fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Changed Too Late' } });
      back.click();
    });

    expect(setupMocks.post).toHaveBeenCalledTimes(1);
    expect(setupMocks.post).toHaveBeenCalledWith(
      '/setup/complete',
      expect.objectContaining({
        name: 'Portal Owner',
        email: 'owner@example.com',
        password: 'ValidPass1',
        allowTelemetry: true,
        tailnetRequested: false,
      }),
      { timeout: 30_000 },
    );
    expect(await screen.findByRole('button', { name: 'Launching Portal…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('heading', { name: 'Create your admin account' })).toBeVisible();
    expect(screen.getByLabelText('Full name')).toBeDisabled();

    await act(async () => {
      firstComplete.reject(Object.assign(new Error('Atomic setup failed.'), { response: { status: 422 } }));
      await Promise.resolve();
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Atomic setup failed.');
    expect(screen.getByRole('button', { name: 'Launch Portal' })).toBeEnabled();
    expect(screen.getByLabelText('Full name')).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Launch Portal' }));
    await waitFor(() => expect(attempts).toBe(2));
    expect(await screen.findByRole('alert')).toHaveTextContent('Retry remains on this step.');
  });

  it('shows a non-retrying recovery surface when committed setup cannot confirm its restart', async () => {
    setupMocks.post.mockImplementation((url: string) => {
      if (url === '/setup/complete') return Promise.resolve({ data: { success: true } });
      throw new Error(`Unexpected POST ${url}`);
    });
    setupMocks.refreshPublicSettings.mockRejectedValue(new Error('Public settings are still unavailable.'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 4000) {
        queueMicrotask(() => callback(...args));
        return 1;
      }
      return realSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);

    renderWizard(2, true);
    fireEvent.change(await screen.findByLabelText('Full name'), { target: { value: 'Portal Owner' } });
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'owner@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'ValidPass1' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'ValidPass1' } });

    act(() => screen.getByRole('button', { name: 'Launch Portal' }).click());
    expect(await screen.findByRole('heading', { name: 'Setup status needs confirmation' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Do not submit setup again');
    expect(screen.queryByText('Portal ready')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Launch Portal' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue to sign in' })).toBeEnabled();
  });

  it('bounds a lost completion response and permits retry only after status authoritatively remains pending', async () => {
    const completion = deferred<{ data: { success: boolean } }>();
    setupMocks.post.mockImplementation((url: string) => {
      if (url === '/setup/complete') return completion.promise;
      throw new Error(`Unexpected POST ${url}`);
    });
    setupMocks.get.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (url === '/setup/status') {
        return {
          data: {
            setupTransport: { allowed: true, transport: 'https' },
            needsSetup: true,
            isReinstall: false,
            requestKind: config?.params?._t ? 'reconciliation' : 'initial',
          },
        };
      }
      if (url === '/setup/system-info') return { data: systemInfo };
      throw new Error(`Unexpected GET ${url}`);
    });

    renderWizard(2, true);
    fireEvent.change(await screen.findByLabelText('Full name'), { target: { value: 'Portal Owner' } });
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'owner@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'ValidPass1' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'ValidPass1' } });

    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 30_000) {
        queueMicrotask(() => callback(...args));
        return 1;
      }
      return realSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    act(() => screen.getByRole('button', { name: 'Launch Portal' }).click());
    expect(setupMocks.post).toHaveBeenCalledWith(
      '/setup/complete',
      expect.objectContaining({ email: 'owner@example.com' }),
      { timeout: 30_000 },
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('setup completion request timed out');
    expect(screen.getByRole('button', { name: 'Launch Portal' })).toBeEnabled();
    expect(screen.queryByText('Setup status needs confirmation')).not.toBeInTheDocument();
    expect(setupMocks.get).toHaveBeenCalledWith(
      '/setup/status',
      expect.objectContaining({
        params: expect.objectContaining({ _t: expect.any(Number) }),
        timeout: 8_000,
      }),
    );
  });

  it('treats a non-validation completion failure as safely retryable when bounded status says setup is pending', async () => {
    let attempts = 0;
    setupMocks.post.mockImplementation((url: string) => {
      if (url !== '/setup/complete') throw new Error(`Unexpected POST ${url}`);
      attempts += 1;
      return Promise.reject(Object.assign(new Error(`Gateway lost response ${attempts}.`), { response: { status: 503 } }));
    });
    setupMocks.get.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (url === '/setup/status') {
        return {
          data: {
            setupTransport: { allowed: true, transport: 'https' },
            needsSetup: true,
            isReinstall: false,
            reconciled: Boolean(config?.params?._t),
          },
        };
      }
      if (url === '/setup/system-info') return { data: systemInfo };
      throw new Error(`Unexpected GET ${url}`);
    });

    renderWizard(2, true);
    fireEvent.change(await screen.findByLabelText('Full name'), { target: { value: 'Portal Owner' } });
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'owner@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'ValidPass1' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'ValidPass1' } });

    await userEvent.click(screen.getByRole('button', { name: 'Launch Portal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Gateway lost response 1.');
    expect(screen.getByRole('button', { name: 'Launch Portal' })).toBeEnabled();
    expect(screen.queryByText('Setup status needs confirmation')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Launch Portal' }));
    await waitFor(() => expect(attempts).toBe(2));
    expect(await screen.findByRole('alert')).toHaveTextContent('Gateway lost response 2.');
  });

  it('recovers a lost completion response as committed when bounded status says setup is complete', async () => {
    setupMocks.post.mockImplementation((url: string) => {
      if (url === '/setup/complete') return Promise.reject(new Error('Connection closed during restart.'));
      throw new Error(`Unexpected POST ${url}`);
    });
    setupMocks.get.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (url === '/setup/status') {
        return {
          data: {
            setupTransport: { allowed: true, transport: 'https' },
            needsSetup: config?.params?._t ? false : true,
            isReinstall: false,
          },
        };
      }
      if (url === '/setup/system-info') return { data: systemInfo };
      throw new Error(`Unexpected GET ${url}`);
    });

    window.history.replaceState({}, '', 'https://portal.example.com/outside');
    window.history.pushState({}, '', 'https://portal.example.com/setup?step=2&mode=quick');
    render(
      <BrowserRouter>
        <Routes>
          <Route path="/setup" element={<SetupWizardPage />} />
          <Route path="/login" element={<div>Recovered login</div>} />
          <Route path="/outside" element={<div>Outside setup</div>} />
        </Routes>
      </BrowserRouter>,
    );
    fireEvent.change(await screen.findByLabelText('Full name'), { target: { value: 'Portal Owner' } });
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'owner@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'ValidPass1' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'ValidPass1' } });

    await userEvent.click(screen.getByRole('button', { name: 'Launch Portal' }));
    expect(await screen.findByText('Recovered login')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Launch Portal' })).not.toBeInTheDocument();
  });

  it('fails closed when the bounded reconciliation status request itself times out', async () => {
    const reconciliation = deferred<{ data: { needsSetup: boolean } }>();
    setupMocks.post.mockImplementation((url: string) => {
      if (url === '/setup/complete') return Promise.reject(new Error('Completion response was lost.'));
      throw new Error(`Unexpected POST ${url}`);
    });
    setupMocks.get.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (url === '/setup/status') {
        if (config?.params?._t) return reconciliation.promise;
        return {
          data: {
            setupTransport: { allowed: true, transport: 'https' },
            needsSetup: true,
            isReinstall: false,
          },
        };
      }
      if (url === '/setup/system-info') return { data: systemInfo };
      throw new Error(`Unexpected GET ${url}`);
    });

    renderWizard(2, true);
    fireEvent.change(await screen.findByLabelText('Full name'), { target: { value: 'Portal Owner' } });
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'owner@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'ValidPass1' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'ValidPass1' } });

    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 8_000) {
        queueMicrotask(() => callback(...args));
        return 1;
      }
      return realSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    act(() => screen.getByRole('button', { name: 'Launch Portal' }).click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByRole('heading', { name: 'Setup status needs confirmation' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Do not submit setup again');
    expect(screen.queryByRole('button', { name: 'Launch Portal' })).not.toBeInTheDocument();
    expect(setupMocks.get).toHaveBeenCalledWith(
      '/setup/status',
      expect.objectContaining({ timeout: 8_000 }),
    );
  });

  it('ignores a delayed mount status completion during active work and releases the sentinel for normal Back afterward', async () => {
    const mountStatus = deferred<{ data: { needsSetup: boolean; isReinstall: boolean } }>();
    const install = deferred<{ data: { success: boolean; domain: string; dnsRecords: []; message: string } }>();
    setupMocks.get.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (url === '/setup/status') {
        if (config?.params?._transport) {
          return {
            data: {
              setupTransport: { allowed: true, transport: 'https' },
              needsSetup: true,
              isReinstall: false,
            },
          };
        }
        return mountStatus.promise;
      }
      if (url === '/setup/system-info') return { data: systemInfo };
      if (url === '/setup/mail-status') return { data: mailStatus };
      if (url === '/setup/mail-preflight') {
        return { data: { provider: 'test', providerName: 'Test VPS', dockerOk: true, port25Open: true, smtpBlocked: false, providerInstructions: null, providerLink: null, canSelfHost: true } };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    setupMocks.post.mockImplementation((url: string) => {
      if (url === '/setup/install-mail') return install.promise;
      throw new Error(`Unexpected POST ${url}`);
    });

    window.history.replaceState({}, '', 'https://portal.example.com/outside');
    window.history.pushState({}, '', 'https://portal.example.com/setup?step=5');
    render(
      <BrowserRouter>
        <Routes>
          <Route path="/setup" element={<SetupWizardPage />} />
          <Route path="/login" element={<div>Unexpected login</div>} />
          <Route path="/outside" element={<div>Outside setup</div>} />
        </Routes>
      </BrowserRouter>,
    );

    const installButton = await screen.findByRole('button', { name: 'Set Up Email' });
    act(() => installButton.click());
    expect(await screen.findByRole('button', { name: 'Setting up email…' })).toBeDisabled();

    await act(async () => {
      mountStatus.resolve({ data: { needsSetup: false, isReinstall: false } });
      await mountStatus.promise;
    });
    expect(screen.queryByText('Unexpected login')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Secure Your Portal' })).toBeVisible();

    await act(async () => {
      install.resolve({ data: { success: true, domain: 'portal.example.com', dnsRecords: [], message: 'Email is ready.' } });
      await install.promise;
    });
    expect(await screen.findByRole('button', { name: 'Set Up Email' })).toBeEnabled();

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(await screen.findByText('Outside setup')).toBeVisible();
    expect(screen.queryByText('Unexpected login')).not.toBeInTheDocument();
  });

  it('collapses the Setup sentinel before successful navigation so Back does not reopen Setup', async () => {
    installGetMocks(true);
    setupMocks.post.mockImplementation((url: string) => {
      if (url === '/setup/reinstall-reset') return Promise.resolve({ data: { email: 'owner@example.com' } });
      throw new Error(`Unexpected POST ${url}`);
    });
    window.history.replaceState({}, '', 'https://portal.example.com/outside');
    window.history.pushState({}, '', 'https://portal.example.com/setup');
    render(
      <BrowserRouter>
        <Routes>
          <Route path="/setup" element={<SetupWizardPage />} />
          <Route path="/login" element={<div>Login destination</div>} />
          <Route path="/outside" element={<div>Outside setup</div>} />
        </Routes>
      </BrowserRouter>,
    );

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('New password'), 'ValidPass1');
    await user.type(screen.getByLabelText('Confirm new password'), 'ValidPass1');
    await user.click(screen.getByRole('button', { name: 'Reset Password & Continue' }));
    expect(await screen.findByText('Login destination')).toBeVisible();

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(await screen.findByText('Outside setup')).toBeVisible();
    expect(screen.queryByText('Welcome Back')).not.toBeInTheDocument();
  });

  it('single-flights reinstall reset with an immutable password and permits a retry after failure', async () => {
    installGetMocks(true);
    const firstReset = deferred<{ data: { email: string } }>();
    let attempts = 0;
    setupMocks.post.mockImplementation((url: string, payload: unknown) => {
      if (url !== '/setup/reinstall-reset') throw new Error(`Unexpected POST ${url}`);
      attempts += 1;
      if (attempts === 1) return firstReset.promise;
      return Promise.reject(new Error(`Retry failed for ${(payload as { password: string }).password}.`));
    });
    renderWizard(0);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('New password'), 'ValidPass1');
    await user.type(screen.getByLabelText('Confirm new password'), 'ValidPass1');
    const reset = screen.getByRole('button', { name: 'Reset Password & Continue' });

    act(() => {
      reset.click();
      reset.click();
      fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'ChangedPass2' } });
    });

    expect(setupMocks.post).toHaveBeenCalledTimes(1);
    expect(setupMocks.post).toHaveBeenCalledWith('/setup/reinstall-reset', { password: 'ValidPass1' });
    expect(await screen.findByRole('button', { name: 'Resetting password…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByLabelText('New password')).toBeDisabled();

    await act(async () => {
      firstReset.reject(new Error('Reset service unavailable.'));
      await Promise.resolve();
    });

    expect(await screen.findByText('Reset service unavailable.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reset Password & Continue' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Reset Password & Continue' }));
    await waitFor(() => expect(attempts).toBe(2));
    expect(await screen.findByText('Retry failed for ValidPass1.')).toBeVisible();
  });
});
