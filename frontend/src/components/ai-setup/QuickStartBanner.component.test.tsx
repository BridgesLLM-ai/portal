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
  it('does not apply an expired OpenClaw profile timestamp to an authenticated native CLI', () => {
    const statusMap = new Map<string, ProviderStatus>([
      ['xai', providerStatus('xai', 'authenticated')],
    ]);
    render(<QuickStartBanner compact statusMap={statusMap} onChoose={vi.fn()} onNativeCliLogin={vi.fn()} />);

    const grokCard = screen.getByRole('button', { name: /Grok Build/i });
    expect(within(grokCard).queryByText('Expired')).not.toBeInTheDocument();
    expect(within(grokCard).queryByText('Needs login')).not.toBeInTheDocument();
  });

  it('shows native login state instead of the unrelated OpenClaw expiry label', () => {
    const statusMap = new Map<string, ProviderStatus>([
      ['anthropic', providerStatus('anthropic', 'needs_login')],
    ]);
    render(<QuickStartBanner compact statusMap={statusMap} onChoose={vi.fn()} onNativeCliLogin={vi.fn()} />);

    const claudeCard = screen.getByRole('button', { name: /Claude Code/i });
    expect(within(claudeCard).getByText('Needs login')).toBeInTheDocument();
    expect(within(claudeCard).queryByText('Expired')).not.toBeInTheDocument();
  });
});
