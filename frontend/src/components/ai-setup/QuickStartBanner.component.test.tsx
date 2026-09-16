// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderStatus } from './ProviderCard';
import QuickStartBanner from './QuickStartBanner';

function providerStatus(
  id: string,
  nativeCliAuthStatus: ProviderStatus['nativeCliAuthStatus'],
  overrides: Partial<ProviderStatus> = {},
): ProviderStatus {
  return {
    id,
    status: 'expired',
    authType: 'oauth',
    profileId: `${id}:openclaw-profile`,
    currentModel: null,
    isDefault: false,
    error: null,
    cooldownUntil: null,
    lastUsed: null,
    expiresAt: Date.now() - 60_000,
    nativeCliAuthStatus,
    ...overrides,
  };
}

describe('QuickStartBanner native credential badges', () => {
  it('offers the Linux x86-64 qualified Grok Build and Antigravity native cards and routes them to the native login', () => {
    const onNativeCliLogin = vi.fn();
    const statusMap = new Map<string, ProviderStatus>([
      ['xai', providerStatus('xai', 'authenticated')],
    ]);
    render(<QuickStartBanner compact statusMap={statusMap} onChoose={vi.fn()} onNativeCliLogin={onNativeCliLogin} />);

    fireEvent.click(screen.getByRole('button', { name: /Grok Build/i }));
    fireEvent.click(screen.getByRole('button', { name: /Antigravity/i }));
    expect(onNativeCliLogin).toHaveBeenNthCalledWith(1, 'grok');
    expect(onNativeCliLogin).toHaveBeenNthCalledWith(2, 'gemini');
    expect(screen.getByRole('button', { name: /^OpenClaw\b/ })).toBeInTheDocument();
  });

  it('shows native login state instead of the unrelated OpenClaw expiry label', () => {
    const statusMap = new Map<string, ProviderStatus>([
      ['anthropic', providerStatus('anthropic', 'needs_login')],
    ]);
    render(<QuickStartBanner compact statusMap={statusMap} onChoose={vi.fn()} onNativeCliLogin={vi.fn()} />);

    const claudeCard = screen.getByRole('button', { name: /Claude Code/i });
    expect(within(claudeCard).getByText('Needs login')).toBeInTheDocument();
    expect(within(claudeCard).getByText(/shared with OpenClaw/i)).toBeInTheDocument();
    expect(within(claudeCard).queryByText(/Project Sandbox/i)).not.toBeInTheDocument();
    expect(within(claudeCard).queryByText('Expired')).not.toBeInTheDocument();
  });

  it('keeps a signed-in Claude login distinct from OpenClaw registration on the card', () => {
    const statusMap = new Map<string, ProviderStatus>([
      ['anthropic', providerStatus('anthropic', 'authenticated', { status: 'unconfigured', expiresAt: null })],
    ]);
    render(<QuickStartBanner statusMap={statusMap} onChoose={vi.fn()} onNativeCliLogin={vi.fn()} />);

    const claudeCard = screen.getByRole('button', { name: /Claude Code/i });
    expect(within(claudeCard).getByText('OpenClaw: not registered')).toBeInTheDocument();
    expect(within(claudeCard).getByText('Reconfigure')).toBeInTheDocument();
  });

  it('offers the ChatGPT / Codex subscription through the OpenClaw provider and reports the Codex harness login separately', () => {
    const onChoose = vi.fn();
    const onNativeCliLogin = vi.fn();
    const statusMap = new Map<string, ProviderStatus>([
      ['openai-codex', providerStatus('openai-codex', 'needs_login', { status: 'unconfigured', expiresAt: null })],
    ]);
    render(<QuickStartBanner statusMap={statusMap} onChoose={onChoose} onNativeCliLogin={onNativeCliLogin} />);

    const codexCard = screen.getByRole('button', { name: /ChatGPT \/ Codex/i });
    expect(within(codexCard).getByText(/Sign in with your ChatGPT account through OpenClaw's own sign-in wizard/i)).toBeInTheDocument();
    expect(within(codexCard).getByText('OpenClaw: not registered · Codex harness: needs login')).toBeInTheDocument();
    fireEvent.click(codexCard);
    expect(onChoose).toHaveBeenCalledWith('openai-codex');
    expect(onNativeCliLogin).not.toHaveBeenCalled();
  });

  it('shows Portal-profile harness setup only on authenticated Settings surfaces', () => {
    const onNativeCliLogin = vi.fn();
    const view = render(
      <QuickStartBanner
        compact
        onChoose={vi.fn()}
        onNativeCliLogin={onNativeCliLogin}
        showHarnessNativeCards={false}
      />,
    );
    expect(screen.queryByRole('button', { name: /Hermes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /OpenCode/i })).not.toBeInTheDocument();

    view.rerender(
      <QuickStartBanner
        compact
        onChoose={vi.fn()}
        onNativeCliLogin={onNativeCliLogin}
        showHarnessNativeCards
      />,
    );
    screen.getByRole('button', { name: /Hermes/i }).click();
    screen.getByRole('button', { name: /OpenCode/i }).click();
    expect(onNativeCliLogin).toHaveBeenNthCalledWith(1, 'hermes');
    expect(onNativeCliLogin).toHaveBeenNthCalledWith(2, 'opencode');
  });
});
