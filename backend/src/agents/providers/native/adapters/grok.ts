import type { NativeCliProviderAdapter } from '../types';

/**
 * Identity/config adapter retained for NativeCliAdapterProvider's session
 * store. GrokProvider overrides turn execution with the strict ACP broker.
 * Keeping this fallback fail-closed prevents a future refactor from silently
 * reviving the old always-approved headless transport.
 */
export const grokAdapter: NativeCliProviderAdapter = {
  providerName: 'GROK',
  displayName: 'Grok Build',
  cliCommand: 'grok',
  messageIdPrefix: 'grok-msg',
  initialStatus: 'Grok Build is working…',
  spawnErrorPrefix: 'Failed to spawn Grok Build ACP',
  buildInvocation: () => {
    throw new Error('Grok Build turns require the pinned ACP stdio broker.');
  },
  handleStdoutLine: () => undefined,
  getErrorMessage: () => 'Grok Build ACP transport was not initialized.',
};
