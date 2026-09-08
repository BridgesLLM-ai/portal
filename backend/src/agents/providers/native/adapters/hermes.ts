import type { NativeCliProviderAdapter } from '../types';

/** Identity-only adapter; Hermes turns always use the pinned ACP broker. */
export const hermesAdapter: NativeCliProviderAdapter = {
  providerName: 'HERMES',
  displayName: 'Hermes',
  cliCommand: 'hermes',
  messageIdPrefix: 'hermes-msg',
  initialStatus: 'Hermes is working…',
  spawnErrorPrefix: 'Failed to spawn Hermes ACP',
  buildInvocation: () => {
    throw new Error('Hermes turns require the pinned ACP stdio broker.');
  },
  handleStdoutLine: () => undefined,
  getErrorMessage: () => 'Hermes ACP transport was not initialized.',
};
