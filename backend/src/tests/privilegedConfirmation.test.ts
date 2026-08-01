import {
  PRIVILEGED_CONFIRMATION,
  confirmationForMailboxDeletion,
  confirmationForOwnershipTransfer,
  confirmationForToolInstall,
  confirmationForUserDeletion,
  isTypedConfirmationMatch,
} from '../utils/privilegedConfirmation';

describe('privileged typed-confirmation contract', () => {
  test('requires an exact, case-sensitive phrase for host mutations', () => {
    expect(isTypedConfirmationMatch(PRIVILEGED_CONFIRMATION.compatibilityHotfix, 'RESTART OPENCLAW')).toBe(true);
    expect(isTypedConfirmationMatch(PRIVILEGED_CONFIRMATION.compatibilityHotfix, 'restart openclaw')).toBe(false);
    expect(isTypedConfirmationMatch(PRIVILEGED_CONFIRMATION.compatibilityHotfix, undefined)).toBe(false);
    expect(isTypedConfirmationMatch(null, undefined)).toBe(true);
    expect(PRIVILEGED_CONFIRMATION.portalUpdate).toBe('UPDATE PORTAL');
    expect(PRIVILEGED_CONFIRMATION.ollamaUnload).toBe('UNLOAD OLLAMA MODELS');
    expect(PRIVILEGED_CONFIRMATION.ollamaRestart).toBe('RESTART OLLAMA');
  });

  test('binds destructive confirmations to the selected target', () => {
    expect(confirmationForUserDeletion(' Person@Example.COM ')).toBe('DELETE person@example.com');
    expect(confirmationForOwnershipTransfer('Person@Example.COM')).toBe('TRANSFER TO person@example.com');
    expect(confirmationForMailboxDeletion('portal-user')).toBe('DELETE MAILBOX portal-user');
    expect(confirmationForToolInstall('codex')).toBe('INSTALL CODEX');
  });
});
