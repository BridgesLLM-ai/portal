import { describe, expect, it } from 'vitest';
import {
  canRemoveProviderStatus,
  getProviderRemovalConfirmation,
  providerStatusCanShowRemoval,
  type ProviderRemovalCapability,
} from './providerRemovalContract';

describe('provider removal contract', () => {
  const supported: ProviderRemovalCapability = {
    supported: true,
    code: 'PORTAL_OWNED_API_KEY',
    reason: 'Exact Portal-owned API-key profile.',
    requiresExactConfirmation: true,
  };
  const unsupported: ProviderRemovalCapability = {
    supported: false,
    code: 'UNSUPPORTED_CREDENTIAL_SURFACE',
    reason: 'Externally managed.',
    requiresExactConfirmation: true,
  };

  it('shows removal only for actionable states with a server-authorized capability', () => {
    for (const status of ['configured', 'error', 'expired', 'cooldown'] as const) {
      expect(providerStatusCanShowRemoval(status)).toBe(true);
      expect(canRemoveProviderStatus(status, supported)).toBe(true);
      expect(canRemoveProviderStatus(status, unsupported)).toBe(false);
      expect(canRemoveProviderStatus(status, undefined)).toBe(false);
    }
    expect(canRemoveProviderStatus('unconfigured', supported)).toBe(false);
    expect(canRemoveProviderStatus('manual', supported)).toBe(false);
    expect(canRemoveProviderStatus(null, supported)).toBe(false);
  });

  it.each(['openrouter', 'mistral', 'deepseek'])('requires exact %s confirmation', (providerId) => {
    const message = getProviderRemovalConfirmation(providerId);
    expect(message).toContain(`"${providerId}"`);
    expect(message).toContain('exact Portal-owned provider profile');
    expect(message).toContain('Other providers and credentials are preserved');
  });
});
