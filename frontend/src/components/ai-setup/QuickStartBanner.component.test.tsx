// @vitest-environment jsdom
import '../../test/setup';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderStatus } from './ProviderCard';
import QuickStartBanner from './QuickStartBanner';

function providerStatus(
  id: string,
  nativeCliAuthStatus: ProviderStatus['nativeCliAuthStatus'],
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
  };
}

describe('QuickStartBanner native credential badges', () => {
  it('does not offer unqualified Grok or Antigravity native setup controls', () => {
    const statusMap = new Map<string, ProviderStatus>([
      ['xai', providerStatus('xai', 'authenticated')],
    ]);
    render(<QuickStartBanner compact statusMap={statusMap} onChoose={vi.fn()} onNativeCliLogin={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /Grok Build/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Antigravity/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /OpenClaw/i })).toBeInTheDocument();
  });

  it('shows native login state instead of the unrelated OpenClaw expiry label', () => {
    const statusMap = new Map<string, ProviderStatus>([
      ['anthropic', providerStatus('anthropic', 'needs_login')],
    ]);
    render(<QuickStartBanner compact statusMap={statusMap} onChoose={vi.fn()} onNativeCliLogin={vi.fn()} />);

    const claudeCard = screen.getByRole('button', { name: /Claude Project Sandbox/i });
    expect(within(claudeCard).getByText('Needs login')).toBeInTheDocument();
    expect(within(claudeCard).queryByText('Expired')).not.toBeInTheDocument();
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
