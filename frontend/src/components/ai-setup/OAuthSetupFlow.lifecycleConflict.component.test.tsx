// @vitest-environment jsdom
import '../../test/setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OAuthSetupFlow from './OAuthSetupFlow';
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

const xaiProvider: ProviderUIConfig = {
  tier: 1,
  icon: 'sparkles',
  consoleUrl: 'https://example.com/console',
  signupUrl: 'https://example.com/signup',
  pricingNote: 'Test pricing',
  freeTier: null,
  description: 'Test provider',
  setupInstructions: [],
  defaultModels: [{ id: 'xai/grok-4.3', name: 'Grok 4.3', tier: 'balanced', description: 'Test model' }],
  id: 'xai',
  name: 'xAI (Grok)',
  primaryAuthType: 'oauth',
  guidedSetup: { status: 'available', authTypes: ['oauth'] },
};

// The exact body the ledger returns for a stuck lifecycle: no sessionId, no
// credentialState. The disposition helper must not route this to the terminal
// error step — the reset action has to stay reachable.
const lifecycleConflictRejection = {
  response: {
    status: 409,
    data: {
      success: false,
      code: 'PROVIDER_CREDENTIAL_LIFECYCLE_CONFLICT',
      error: 'A credential changed while Portal was recovering the previous authorization lifecycle. Remove or verify it before retrying.',
    },
  },
};

async function reachStartAndSignIn() {
  render(<OAuthSetupFlow provider={xaiProvider} apiBase="/api/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: /I'm ready/i }));
  await userEvent.click(screen.getByRole('button', { name: /Sign in with xAI/i }));
}

describe('OAuthSetupFlow stuck-lifecycle conflict recovery', () => {
  beforeEach(() => {
    mocks.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/status')) return { data: { defaultModel: null } };
      if (url.endsWith('/models')) return { data: { models: [] } };
      return { data: {} };
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('offers the reset action instead of the terminal error step on a conflict 409', async () => {
    mocks.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/oauth/start')) throw lifecycleConflictRejection;
      return { data: {} };
    });

    await reachStartAndSignIn();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Reset the previous sign-in and try again/i })).toBeTruthy();
    });
    expect(screen.getByText(/recovering the previous authorization lifecycle/i)).toBeTruthy();
    expect(screen.queryByText(/Setup failed/i)).toBeNull();
    // The user can still retry sign-in from the same step.
    expect(screen.getByRole('button', { name: /Sign in with xAI/i })).toBeTruthy();
  });

  it('reset action clears the lifecycle and retries into the device step', async () => {
    let startAttempts = 0;
    mocks.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/oauth/start')) {
        startAttempts += 1;
        if (startAttempts === 1) throw lifecycleConflictRejection;
        return {
          data: {
            sessionId: 'oauth_retry_1',
            userCode: 'ABCD-1234',
            verificationUrl: 'https://accounts.x.ai/activate',
            expiresIn: 600,
          },
        };
      }
      if (url.endsWith('/oauth/reset-lifecycle')) {
        return { data: { success: true, cleared: true } };
      }
      return { data: {} };
    });

    await reachStartAndSignIn();

    const resetButton = await screen.findByRole('button', { name: /Reset the previous sign-in and try again/i });
    await userEvent.click(resetButton);

    await waitFor(() => {
      expect(screen.getByText('ABCD-1234')).toBeTruthy();
    });
    expect(mocks.post.mock.calls.some((call: any[]) => String(call[0]).endsWith('/oauth/reset-lifecycle') && call[1]?.provider === 'xai')).toBe(true);
    expect(startAttempts).toBe(2);
  });

  it('keeps a busy operation-gate 409 as a retryable inline notice', async () => {
    mocks.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/oauth/start')) {
        throw {
          response: {
            status: 409,
            data: {
              success: false,
              error: 'Another xAI operation (oauth) is already running. Finish it before starting oauth.',
            },
          },
        };
      }
      return { data: {} };
    });

    await reachStartAndSignIn();

    await waitFor(() => {
      expect(screen.getByText(/already running/i)).toBeTruthy();
    });
    expect(screen.queryByText(/Setup failed/i)).toBeNull();
    expect(screen.getByRole('button', { name: /Sign in with xAI/i })).toBeTruthy();
  });
});
