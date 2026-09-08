import type { NativeCliProviderAdapter } from '../types';

/** Identity-only adapter; OpenCode turns always use the pinned ACP broker. */
export const openCodeAdapter: NativeCliProviderAdapter = {
  providerName: 'OPENCODE',
  displayName: 'OpenCode',
  cliCommand: 'opencode',
  messageIdPrefix: 'opencode-msg',
  initialStatus: 'OpenCode is working…',
  spawnErrorPrefix: 'Failed to spawn OpenCode ACP',
  buildInvocation: () => {
    throw new Error('OpenCode turns require the pinned ACP stdio broker.');
  },
  handleStdoutLine: () => undefined,
  getErrorMessage: () => 'OpenCode ACP transport was not initialized.',
};
