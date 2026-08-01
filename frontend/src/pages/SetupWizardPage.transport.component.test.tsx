// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://portal.example.com/setup#bootstrap=abcdefghijklmnopqrstuvwxyzABCDEFGH12345678"}
import '../test/setup';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import SetupWizardPage from './SetupWizardPage';

const setupMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  interceptorUse: vi.fn(() => 1),
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

describe('SetupWizardPage transport guard', () => {
  it('renders a hard stop on public HTTP without sending bootstrap material or exposing credential fields', () => {
    setupMocks.get.mockResolvedValue({ data: {} });
    render(
      <MemoryRouter>
        <SetupWizardPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Setup is blocked on public HTTP' })).toBeVisible();
    expect(screen.getByText(/will not collect a bootstrap bearer, owner password, or provider credential/i)).toBeVisible();
    expect(screen.getByText(/ssh -N -L 4001:127\.0\.0\.1:4001/i)).toBeVisible();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(setupMocks.get).toHaveBeenCalledTimes(1);
    expect(setupMocks.get).toHaveBeenCalledWith('/setup/status', { timeout: 8_000 });
    expect(setupMocks.post).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
  });
});
