const mailboxFindMany = jest.fn();
const syncAutoForwardRule = jest.fn();
const decryptSecret = jest.fn();

jest.mock('../config/database', () => ({
  prisma: {
    mailboxAccount: { findMany: mailboxFindMany },
  },
}));

jest.mock('../services/mailService', () => ({
  syncAutoForwardRule,
}));

jest.mock('../utils/authSecrets', () => ({
  decryptSecret,
}));

import { syncConfiguredAutoForwardRules } from '../cron-jobs';

describe('mail background capability backstops', () => {
  const originalOriginMode = process.env.ORIGIN_MODE;
  const originalInstallProfile = process.env.INSTALL_PROFILE;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ORIGIN_MODE;
    process.env.INSTALL_PROFILE = 'server';
    mailboxFindMany.mockResolvedValue([
      {
        username: 'alice',
        mailPassword: 'encrypted-password',
        autoForwardTo: 'external@example.test',
      },
    ]);
    decryptSecret.mockReturnValue('mail-password');
    syncAutoForwardRule.mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (originalOriginMode === undefined) delete process.env.ORIGIN_MODE;
    else process.env.ORIGIN_MODE = originalOriginMode;
    if (originalInstallProfile === undefined) delete process.env.INSTALL_PROFILE;
    else process.env.INSTALL_PROFILE = originalInstallProfile;
  });

  test.each([
    { ORIGIN_MODE: 'tailnet', INSTALL_PROFILE: 'server' },
    { ORIGIN_MODE: '', INSTALL_PROFILE: 'local' },
  ])('skips mailbox discovery, secret decryption, and JMAP sync when mail is unavailable ($ORIGIN_MODE/$INSTALL_PROFILE)', async (environment) => {
    process.env.ORIGIN_MODE = environment.ORIGIN_MODE;
    process.env.INSTALL_PROFILE = environment.INSTALL_PROFILE;

    await syncConfiguredAutoForwardRules();

    expect(mailboxFindMany).not.toHaveBeenCalled();
    expect(decryptSecret).not.toHaveBeenCalled();
    expect(syncAutoForwardRule).not.toHaveBeenCalled();
  });

  test('preserves domain-mode auto-forward reconciliation', async () => {
    await syncConfiguredAutoForwardRules();

    expect(mailboxFindMany).toHaveBeenCalledTimes(1);
    expect(decryptSecret).toHaveBeenCalledWith('encrypted-password');
    expect(syncAutoForwardRule).toHaveBeenCalledWith(
      'external@example.test',
      'alice',
      'mail-password',
    );
  });
});
