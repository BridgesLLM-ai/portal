import { prisma } from '../config/database';
import { decryptSecret, encryptSecret } from '../utils/authSecrets';

/**
 * Encrypt pre-4.0 database secrets before the HTTP server accepts traffic.
 * Reading every ciphertext first also validates that the configured key can
 * authenticate all existing values; a wrong key aborts startup fail-closed.
 */
export async function encryptStoredSecretsAtBoot(): Promise<void> {
  let updated = 0;

  await prisma.$transaction(async (tx) => {
    const [users, mailboxes, smtpPassword] = await Promise.all([
      tx.user.findMany({
        where: {
          OR: [
            { twoFactorSecret: { not: null } },
            { mailPassword: { not: null } },
          ],
        },
        select: { id: true, twoFactorSecret: true, mailPassword: true },
      }),
      tx.mailboxAccount.findMany({
        select: { id: true, mailPassword: true },
      }),
      tx.systemSetting.findUnique({
        where: { key: 'smtp.password' },
        select: { key: true, value: true },
      }),
    ]);

    for (const user of users) {
      const data: { twoFactorSecret?: string; mailPassword?: string } = {};
      if (user.twoFactorSecret) {
        decryptSecret(user.twoFactorSecret);
        const encrypted = encryptSecret(user.twoFactorSecret);
        if (encrypted !== user.twoFactorSecret) data.twoFactorSecret = encrypted;
      }
      if (user.mailPassword) {
        decryptSecret(user.mailPassword);
        const encrypted = encryptSecret(user.mailPassword);
        if (encrypted !== user.mailPassword) data.mailPassword = encrypted;
      }
      if (Object.keys(data).length > 0) {
        await tx.user.update({ where: { id: user.id }, data });
        updated += 1;
      }
    }

    for (const mailbox of mailboxes) {
      decryptSecret(mailbox.mailPassword);
      const encrypted = encryptSecret(mailbox.mailPassword);
      if (encrypted !== mailbox.mailPassword) {
        await tx.mailboxAccount.update({
          where: { id: mailbox.id },
          data: { mailPassword: encrypted },
        });
        updated += 1;
      }
    }

    if (smtpPassword?.value) {
      decryptSecret(smtpPassword.value);
      const encrypted = encryptSecret(smtpPassword.value);
      if (encrypted !== smtpPassword.value) {
        await tx.systemSetting.update({
          where: { key: smtpPassword.key },
          data: { value: encrypted },
        });
        updated += 1;
      }
    }
  }, { timeout: 60_000 });

  if (updated > 0) {
    console.log(`[security] Encrypted ${updated} legacy secret record(s) at rest`);
  }
}
