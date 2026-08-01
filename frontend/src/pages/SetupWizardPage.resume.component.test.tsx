// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://portal.example.com/setup?step=2&mode=quick"}
import '../test/setup';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SetupWizardPage from './SetupWizardPage';
import { SETUP_SESSION_STORAGE_KEY } from './setupWizardFlow';

const setupMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  interceptorUse: vi.fn(),
  interceptorEject: vi.fn(),
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
  useAuthStore: () => ({ restoreSession: vi.fn() }),
}));

vi.mock('../components/ai-setup/AiProviderSetup', () => ({
  default: () => <div>AI provider setup</div>,
}));

vi.mock('../utils/sounds', () => ({
  sounds: { click: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock('../hooks/usePublicSettings', () => ({
  refreshPublicSettings: vi.fn(),
}));

const SESSION_TOKEN = 'setup_session_abcdefghijklmnopqrstuvwxyz1234567890';

describe('SetupWizardPage resumed protected session', () => {
  let requestInterceptor: ((config: any) => any) | undefined;

  beforeEach(() => {
    window.sessionStorage.setItem(SETUP_SESSION_STORAGE_KEY, SESSION_TOKEN);
    setupMocks.get.mockReset();
    setupMocks.post.mockReset();
    setupMocks.interceptorUse.mockReset();
    setupMocks.interceptorUse.mockImplementation((interceptor) => {
      requestInterceptor = interceptor;
      return 7;
    });
    setupMocks.get.mockImplementation(async (url: string) => {
      if (url === '/setup/status') {
        return { data: { setupTransport: { allowed: true, transport: 'https' } } };
      }
      if (url === '/setup/system-info') {
        return {
          data: {
            publicIp: '203.0.113.8',
            ramGb: 16,
            diskGb: 80,
            cpus: 4,
            osName: 'Test Linux',
            components: {},
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
  });

  it('restores navigation without replaying bootstrap and keeps the owner form gated by validation', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SetupWizardPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Create your admin account' })).toBeVisible();
    expect(screen.getByText('Quick setup')).toBeVisible();
    expect(screen.getByLabelText('Full name')).toBeEnabled();
    expect(screen.getByLabelText('Email address')).toBeEnabled();
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute('type', 'password');

    const launch = screen.getByRole('button', { name: /Launch Portal/i });
    expect(launch).toBeDisabled();
    await user.type(screen.getByLabelText('Full name'), 'Portal Owner');
    await user.type(screen.getByLabelText('Email address'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'ValidPass1');
    await user.type(screen.getByLabelText('Confirm password'), 'ValidPass1');
    expect(launch).toBeEnabled();

    expect(setupMocks.post).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\/setup\/bootstrap/),
      expect.anything(),
      expect.anything(),
    );
    expect(requestInterceptor).toBeTypeOf('function');
    expect(requestInterceptor?.({ url: '/setup/system-info', headers: {} })).toMatchObject({
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    });
  });
});
