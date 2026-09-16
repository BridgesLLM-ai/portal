// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../contexts/AuthContext';
import OpenClawAuthWizardFlow from './OpenClawAuthWizardFlow';
import type { ProviderUIConfig } from './providerConfig';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  default: {
    get: mocks.get,
    post: mocks.post,
  },
}));

const codex: ProviderUIConfig = {
  id: 'openai-codex',
  name: 'OpenAI Codex (ChatGPT Subscription)',
  icon: 'code-2',
  tier: 1,
  primaryAuthType: 'oauth',
  guidedSetup: { status: 'available', authTypes: ['oauth'] },
  consoleUrl: 'https://chatgpt.com/',
  signupUrl: 'https://chatgpt.com/',
  pricingNote: 'Uses your ChatGPT subscription.',
  freeTier: null,
  description: 'ChatGPT subscription through OpenClaw.',
  setupInstructions: [],
  defaultModels: [],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('OpenClawAuthWizardFlow', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAuthStore.setState({ user: null, isAuthenticated: false });
    mocks.get.mockReset();
    mocks.post.mockReset();
  });

  it('drives the server-owned native wizard: start, select, masked text, completion', async () => {
    mocks.post.mockImplementation((url: string, body: any) => {
      if (url === '/ai-setup/oauth/start') {
        return Promise.resolve({
          data: {
            success: true,
            sessionId: 'wiz-1',
            transport: 'native-wizard',
            status: 'awaiting_input',
            step: { id: 'method', type: 'select', title: 'Choose how to sign in', options: [{ value: 'oauth', label: 'ChatGPT sign-in', description: 'Uses your subscription' }] },
          },
        });
      }
      if (url === '/ai-setup/oauth/answer' && body.stepId === 'method') {
        return Promise.resolve({
          data: {
            sessionId: 'wiz-1',
            status: 'awaiting_input',
            step: { id: 'code', type: 'text', title: 'Paste the authorization code', message: 'Open https://auth.openai.com/codex/device and paste the code shown.', sensitive: true },
          },
        });
      }
      if (url === '/ai-setup/oauth/answer' && body.stepId === 'code') {
        return Promise.resolve({ data: { sessionId: 'wiz-1', status: 'complete', finalized: true } });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    const onComplete = vi.fn();
    const onCancel = vi.fn();

    render(<OpenClawAuthWizardFlow provider={codex} apiBase="/ai-setup" onComplete={onComplete} onCancel={onCancel} />);

    expect(screen.getByRole('dialog', { name: /Sign in to OpenAI Codex/i })).toBeInTheDocument();
    expect(screen.getByText(/default model and fallbacks stay unchanged/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Start OpenAI Codex .* sign-in/i }));

    const option = await screen.findByRole('button', { name: /ChatGPT sign-in/i });
    const startBody = mocks.post.mock.calls[0][1];
    expect(startBody.provider).toBe('openai-codex');
    expect(startBody.operationId).toMatch(UUID);
    fireEvent.click(option);
    expect(mocks.post).toHaveBeenLastCalledWith('/ai-setup/oauth/answer', { sessionId: 'wiz-1', stepId: 'method', value: 'oauth' });

    const codeInput = await screen.findByLabelText('Paste the authorization code');
    expect(codeInput).toHaveAttribute('type', 'password');
    expect(screen.getByRole('link', { name: /Open auth.openai.com/i })).toHaveAttribute('href', 'https://auth.openai.com/codex/device');
    fireEvent.change(codeInput, { target: { value: 'ABCD-1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(await screen.findByText(/Signed in to OpenAI Codex .* through OpenClaw/i)).toBeInTheDocument();
    expect(mocks.post).toHaveBeenLastCalledWith('/ai-setup/oauth/answer', { sessionId: 'wiz-1', stepId: 'code', value: 'ABCD-1234' });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(screen.queryByDisplayValue('ABCD-1234')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Continue to models/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('fails closed and cancels the session when the server offers a different transport', async () => {
    mocks.post.mockImplementation((url: string) => {
      if (url === '/ai-setup/oauth/start') {
        return Promise.resolve({ data: { success: true, sessionId: 'legacy-1', transport: 'device', status: 'pending' } });
      }
      if (url === '/ai-setup/oauth/cancel') return Promise.resolve({ status: 200, data: { success: true, status: 'cancelled' } });
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    const onComplete = vi.fn();

    render(<OpenClawAuthWizardFlow provider={codex} apiBase="/ai-setup" onComplete={onComplete} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Start OpenAI Codex .* sign-in/i }));

    await waitFor(() => expect(screen.getAllByText(/did not offer OpenClaw's native sign-in wizard .* \(transport: device\)/i).length).toBeGreaterThanOrEqual(1));
    expect(screen.getAllByText(/The session was cancelled and nothing was saved/i).length).toBeGreaterThanOrEqual(1);
    expect(mocks.post).toHaveBeenCalledWith('/ai-setup/oauth/cancel', { sessionId: 'legacy-1' }, { timeout: 10_000 });
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows the server rejection and keeps the review boundary when the start is refused', async () => {
    mocks.post.mockRejectedValueOnce({
      response: {
        status: 409,
        data: { success: false, error: 'A previous sign-in still owns this provider.', code: 'PROVIDER_CREDENTIAL_LIFECYCLE_CONFLICT', credentialState: 'committed' },
      },
    });

    render(<OpenClawAuthWizardFlow provider={codex} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Start OpenAI Codex .* sign-in/i }));

    await waitFor(() => expect(screen.getAllByText(/A previous sign-in still owns this provider/i).length).toBeGreaterThanOrEqual(1));
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });
});
