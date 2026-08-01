const transaction = jest.fn();
const mockRequireMailboxReconciled = jest.fn();
const mockEnqueueMailboxReconciliation = jest.fn();

jest.mock('../config/database', () => ({
  prisma: {
    $transaction: transaction,
    user: { findUnique: jest.fn() },
    mailboxAccount: { findMany: jest.fn() },
  },
}));

jest.mock('../services/mailboxReconciliation', () => ({
  requireMailboxReconciled: mockRequireMailboxReconciled,
  enqueueMailboxReconciliation: mockEnqueueMailboxReconciliation,
}));

import { decryptSecret } from '../utils/authSecrets';
import { provisionUserMailbox } from '../services/userMailService';
import { PortalFeatureUnavailableError } from '../utils/portalFeatureCapabilities';

describe('user mailbox persistence invariants', () => {
  const originalStalwartUrl = process.env.STALWART_URL;
  const originalEncryptionKey = process.env.PORTAL_ENCRYPTION_KEY;
  const originalOriginMode = process.env.ORIGIN_MODE;
  const originalInstallProfile = process.env.INSTALL_PROFILE;

  beforeEach(() => {
    transaction.mockReset();
    mockRequireMailboxReconciled.mockReset();
    mockRequireMailboxReconciled.mockResolvedValue(undefined);
    mockEnqueueMailboxReconciliation.mockReset();
    mockEnqueueMailboxReconciliation.mockResolvedValue(undefined);
    process.env.STALWART_URL = 'http://stalwart.test';
    process.env.PORTAL_ENCRYPTION_KEY = 'mailbox-test-encryption-key';
    delete process.env.ORIGIN_MODE;
    process.env.INSTALL_PROFILE = 'server';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalStalwartUrl === undefined) delete process.env.STALWART_URL;
    else process.env.STALWART_URL = originalStalwartUrl;
    if (originalEncryptionKey === undefined) delete process.env.PORTAL_ENCRYPTION_KEY;
    else process.env.PORTAL_ENCRYPTION_KEY = originalEncryptionKey;
    if (originalOriginMode === undefined) delete process.env.ORIGIN_MODE;
    else process.env.ORIGIN_MODE = originalOriginMode;
    if (originalInstallProfile === undefined) delete process.env.INSTALL_PROFILE;
    else process.env.INSTALL_PROFILE = originalInstallProfile;
  });

  test.each([
    { ORIGIN_MODE: 'tailnet', INSTALL_PROFILE: 'server' },
    { ORIGIN_MODE: '', INSTALL_PROFILE: 'local' },
  ])('rejects unavailable mail before starting a mailbox transaction ($ORIGIN_MODE/$INSTALL_PROFILE)', async (environment) => {
    process.env.ORIGIN_MODE = environment.ORIGIN_MODE;
    process.env.INSTALL_PROFILE = environment.INSTALL_PROFILE;

    await expect(provisionUserMailbox('alice', 'user-1')).rejects.toBeInstanceOf(
      PortalFeatureUnavailableError,
    );

    expect(transaction).not.toHaveBeenCalled();
    expect(mockRequireMailboxReconciled).not.toHaveBeenCalled();
    expect(mockEnqueueMailboxReconciliation).not.toHaveBeenCalled();
  });

  test('serializes ownership, creates a primary, and stores only encrypted passwords', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      mailboxAccount: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn().mockResolvedValue({ id: 'mailbox-1' }),
      },
      user: {
        update: jest.fn().mockResolvedValue({ id: 'user-1' }),
      },
    };
    transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));

    const password = await provisionUserMailbox(' Alice ', 'user-1', { makePrimary: false });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.mailboxAccount.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { isPrimary: false },
    });
    expect(tx.mailboxAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { username: 'alice' },
      create: expect.objectContaining({ userId: 'user-1', username: 'alice', isPrimary: true }),
    }));

    const persistedPassword = tx.mailboxAccount.upsert.mock.calls[0][0].create.mailPassword;
    expect(persistedPassword).toMatch(/^portal-secret:v1:/);
    expect(persistedPassword).not.toContain(password);
    expect(decryptSecret(persistedPassword)).toBe(password);
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { mailPassword: persistedPassword },
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30_000 });
    expect(mockRequireMailboxReconciled).toHaveBeenCalledWith('alice');
  });

  test('keeps the desired mailbox state durable when immediate reconciliation is pending', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      mailboxAccount: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn().mockResolvedValue({ id: 'mailbox-1' }),
      },
      user: { update: jest.fn().mockResolvedValue({ id: 'user-1' }) },
    };
    transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
    mockRequireMailboxReconciled.mockRejectedValue(new Error('Mailbox reconciliation is queued for retry'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(provisionUserMailbox('alice', 'user-1'))
      .rejects.toThrow('Mailbox reconciliation is queued for retry');
    expect(tx.mailboxAccount.upsert).toHaveBeenCalledTimes(1);
    const persistedPassword = tx.mailboxAccount.upsert.mock.calls[0][0].create.mailPassword;
    expect(persistedPassword).toMatch(/^portal-secret:v1:/);
    expect(mockRequireMailboxReconciled).toHaveBeenCalledWith('alice');
  });
});
