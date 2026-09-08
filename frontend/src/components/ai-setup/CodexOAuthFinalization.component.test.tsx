// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NativeCliSetupFlow from './NativeCliSetupFlow';
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

const codexProvider: ProviderUIConfig = {
  tier: 1,
  icon: 'sparkles',
  consoleUrl: 'https://chatgpt.com/',
  signupUrl: 'https://chatgpt.com/',
  pricingNote: 'Paid ChatGPT plan',
  freeTier: null,
  description: 'OpenAI Codex',
  setupInstructions: [],
  defaultModels: [{ id: 'openai/gpt-5.5', name: 'GPT-5.5', tier: 'frontier', description: 'Codex model' }],
  id: 'openai-codex',
  name: 'OpenAI Codex',
  primaryAuthType: 'oauth',
  guidedSetup: { status: 'available', authTypes: ['oauth'] },
};

describe('Codex host setup supervisor boundary', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails the unified Codex handoff closed without starting or finalizing a host login', async () => {
    const onComplete = vi.fn();
    const onCancel = vi.fn();

    render(<OAuthSetupFlow provider={codexProvider} apiBase="/ai-setup" onComplete={onComplete} onCancel={onCancel} />);
    expect(screen.getByRole('link', { name: 'OpenAI instructions' })).toHaveAttribute(
      'href',
      'https://developers.openai.com/codex/auth#login-on-headless-devices',
    );
    fireEvent.click(screen.getByRole('button', { name: /I'm ready/i }));
    fireEvent.click(screen.getByRole('button', { name: /Sign in with OpenAI/i }));

    expect(await screen.findByText(/Interactive Codex host sign-in is unavailable from Portal/i)).toBeInTheDocument();
    expect(screen.getByText(/Existing credentials are preserved for supervised Agent Chat/i)).toBeInTheDocument();
    expect(screen.queryByText(/Signed in successfully/i)).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('renders direct host Codex as unavailable and exposes no login mutation', () => {
    const onCancel = vi.fn();

    render(<NativeCliSetupFlow provider="codex" apiBase="/ai-setup" onComplete={vi.fn()} onCancel={onCancel} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/Interactive host Codex login is unavailable.*Supervised Agent Chat can use an existing attested host credential/i);
    expect(screen.getByText(/Project Sandbox uses its separate confined credential/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start Codex Login/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /OpenAI instructions/i })).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close Codex login' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('never revives a host mutation when the unified unavailable state is retried', async () => {
    render(<OAuthSetupFlow provider={codexProvider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /I'm ready/i }));
    fireEvent.click(screen.getByRole('button', { name: /Sign in with OpenAI/i }));
    expect(await screen.findByText(/Interactive Codex host sign-in is unavailable from Portal/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    fireEvent.click(await screen.findByRole('button', { name: /I'm ready/i }));
    fireEvent.click(screen.getByRole('button', { name: /Sign in with OpenAI/i }));

    expect(await screen.findByText(/Interactive Codex host sign-in is unavailable from Portal/i)).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
