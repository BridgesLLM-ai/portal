export type RemovableProviderStatus = 'configured' | 'unconfigured' | 'error' | 'expired' | 'cooldown' | 'manual';

export interface ProviderRemovalCapability {
  supported: boolean;
  code: 'PORTAL_OWNED_API_KEY' | 'UNSUPPORTED_CREDENTIAL_SURFACE';
  reason: string;
  requiresExactConfirmation: true;
}

export function providerStatusCanShowRemoval(
  status: RemovableProviderStatus | null | undefined,
): boolean {
  return status === 'configured'
    || status === 'error'
    || status === 'expired'
    || status === 'cooldown';
}

export function canRemoveProviderStatus(
  status: RemovableProviderStatus | null | undefined,
  capability: ProviderRemovalCapability | null | undefined,
): boolean {
  return providerStatusCanShowRemoval(status) && capability?.supported === true;
}

export function getProviderRemovalConfirmation(providerId: string): string {
  return `Type "${providerId}" to disconnect only the exact Portal-owned provider profile, model catalog, and routing references. Other providers and credentials are preserved.`;
}
