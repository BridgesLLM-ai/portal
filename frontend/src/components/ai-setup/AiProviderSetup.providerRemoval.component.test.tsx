// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AiProviderSetup from './AiProviderSetup';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  default: {
    get: mocks.get,
    delete: mocks.remove,
  },
}));

const openrouterProvider = {
  id: 'openrouter',
  name: 'OpenRouter',
  icon: 'route',
  tier: 1,
  authTypes: ['api_key'],
  primaryAuthType: 'api_key',
  guidedSetup: { status: 'available', authTypes: ['api_key'] },
  authOptions: [],
  keyPrefix: 'sk-or-',
  keyPlaceholder: 'sk-or-v1-...',
  consoleUrl: 'https://openrouter.ai/settings/keys',
  signupUrl: 'https://openrouter.ai/',
  pricingNote: 'Provider pricing.',
  freeTier: null,
  description: 'Portal-owned API-key provider.',
  setupInstructions: [],
  defaultModels: [],
};

function statusPayload() {
  return {
    openclawInstalled: true,
    openclawVersion: '2026.7.1',
    gatewayRunning: true,
    providers: [{
      id: 'openrouter',
      status: 'configured',
      authType: 'api_key',
      profileId: 'openrouter:default',
      currentModel: 'openrouter/model',
      isDefault: true,
      error: null,
      cooldownUntil: null,
      lastUsed: null,
      expiresAt: null,
      removal: {
        supported: true,
        code: 'PORTAL_OWNED_API_KEY',
        reason: 'Exact Portal-owned API-key profile.',
        requiresExactConfirmation: true,
      },
    }],
    defaultModel: 'openrouter/model',
    fallbackModels: [],
    configuredProfileCount: 1,
    activeProfiles: ['openrouter:default'],
  };
}

describe('AiProviderSetup provider removal', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.remove.mockReset();
    mocks.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/catalog')) {
        return { data: { source: 'backend', providers: [openrouterProvider] } };
      }
      if (url.endsWith('/status')) return { data: statusPayload() };
      throw new Error(`Unexpected GET ${url}`);
    });
  });

  it('requires exact typed confirmation and retries with the same actor operation UUID', async () => {
    mocks.remove
      .mockRejectedValueOnce({ response: { data: { error: 'The exact operation remains safe to retry.' } } })
      .mockResolvedValueOnce({ data: { success: true, disconnected: true } });

    render(<AiProviderSetup mode="settings" apiBase="/ai-setup" />);
    fireEvent.click(await screen.findByRole('button', { name: /OpenClaw/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(screen.getByRole('heading', { name: 'Disconnect OpenRouter' })).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Disconnect provider' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Provider id'), { target: { value: 'OpenRouter' } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Provider id'), { target: { value: 'openrouter' } });
    expect(submit).toBeEnabled();

    fireEvent.click(submit);
    expect(await screen.findByText('The exact operation remains safe to retry.')).toBeInTheDocument();
    const firstRequest = mocks.remove.mock.calls[0];
    expect(firstRequest[0]).toBe('/ai-setup/provider/openrouter');
    expect(firstRequest[1]).toEqual({
      data: {
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        confirmationProvider: 'openrouter',
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect provider' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(2));
    expect(mocks.remove.mock.calls[1][1].data.operationId)
      .toBe(firstRequest[1].data.operationId);
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Disconnect OpenRouter' })).not.toBeInTheDocument();
    });
  });

  it('rotates the UUID only when the server proves the request was not admitted', async () => {
    mocks.remove
      .mockRejectedValueOnce({
        response: {
          data: {
            error: 'That UUID belongs to another completed request.',
            operationDisposition: 'not_admitted',
          },
        },
      })
      .mockResolvedValueOnce({ data: { success: true, disconnected: true } });

    render(<AiProviderSetup mode="settings" apiBase="/ai-setup" />);
    fireEvent.click(await screen.findByRole('button', { name: /OpenClaw/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    fireEvent.change(screen.getByLabelText('Provider id'), { target: { value: 'openrouter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect provider' }));
    expect(await screen.findByText('That UUID belongs to another completed request.')).toBeInTheDocument();
    const firstOperationId = mocks.remove.mock.calls[0][1].data.operationId;

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect provider' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(2));
    expect(mocks.remove.mock.calls[1][1].data.operationId).not.toBe(firstOperationId);
  });
});
