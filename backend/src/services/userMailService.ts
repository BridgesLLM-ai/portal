/**
 * User Mail Provisioning Service
 *
 * Mailboxes are first-class user-owned accounts, not just a single field on User.
 * A user may have multiple personal mailboxes over time; one is marked primary.
 */

import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { isReservedSystemMailboxUsername, normalizeMailboxUsername } from '../utils/reservedMailboxUsernames';
import { decryptSecret, encryptSecret } from '../utils/authSecrets';
import { assertPortalFeatureAvailable } from '../utils/portalFeatureCapabilities';
import {
  enqueueMailboxReconciliation,
  requireMailboxReconciled,
} from './mailboxReconciliation';

function getMailDomain() { return process.env.MAIL_DOMAIN || 'localhost'; }

function generateMailPassword(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(32);
  let password = '';
  for (let i = 0; i < 32; i++) {
    password += chars[bytes[i] % chars.length];
  }
  return password;
}

async function lockUserMailboxRows(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
}

async function lockMailboxUsername(tx: Prisma.TransactionClient, username: string): Promise<void> {
  // The void return of pg_advisory_xact_lock is not deserializable; cast it.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${username}, 7124))::text`;
}

async function ensureLegacyMailboxMigrated(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      username: true,
      mailPassword: true,
      mailboxAccounts: {
        take: 1,
        select: { id: true },
      },
    },
  });

  if (!user || user.mailboxAccounts.length > 0 || !user.username || !user.mailPassword) {
    return;
  }

  const normalized = normalizeMailboxUsername(user.username);
  if (isReservedSystemMailboxUsername(normalized)) {
    console.warn(`[userMail] Skipping legacy mailbox migration for reserved system username '${normalized}' on user ${userId}`);
    return;
  }

  const encryptedPassword = encryptSecret(decryptSecret(user.mailPassword));
  await prisma.$transaction(async (tx) => {
    await lockMailboxUsername(tx, normalized);
    await lockUserMailboxRows(tx, userId);
    const existingMailboxOwner = await tx.mailboxAccount.findUnique({
      where: { username: normalized },
      select: { userId: true },
    });
    if (existingMailboxOwner && existingMailboxOwner.userId !== userId) {
      throw new Error(`Mailbox username '${normalized}' is already owned by another Portal user`);
    }

    await tx.mailboxAccount.updateMany({ where: { userId }, data: { isPrimary: false } });
    await tx.mailboxAccount.upsert({
      where: { username: normalized },
      update: { mailPassword: encryptedPassword, isPrimary: true },
      create: { userId, username: normalized, mailPassword: encryptedPassword, isPrimary: true },
    });
    await tx.user.update({ where: { id: userId }, data: { mailPassword: encryptedPassword } });
  });
  await requireMailboxReconciled(normalized);
}

export async function provisionUserMailbox(
  username: string,
  userId: string,
  options?: { makePrimary?: boolean }
): Promise<string> {
  // Mailbox desired state must not be created in origin modes that cannot
  // operate mail. Keep this assertion ahead of the Prisma transaction so
  // Tailnet/local mode cannot leave stale rows for the reconciler to process.
  assertPortalFeatureAvailable('mail');

  const stalwartName = normalizeMailboxUsername(username);
  if (!stalwartName) throw new Error('Mailbox username is required');
  if (isReservedSystemMailboxUsername(stalwartName)) {
    throw new Error(`Mailbox username '${stalwartName}' is reserved for system use`);
  }

  try {
    const password = await prisma.$transaction(async (tx) => {
      // The username advisory lock protects global mailbox ownership, while
      // the user-row lock serializes primary selection for this account.
      await lockMailboxUsername(tx, stalwartName);
      await lockUserMailboxRows(tx, userId);
      const existingMailbox = await tx.mailboxAccount.findUnique({
        where: { username: stalwartName },
        select: { mailPassword: true, userId: true },
      });
      if (existingMailbox && existingMailbox.userId !== userId) {
        throw new Error(`Mailbox username '${stalwartName}' is already owned by another Portal user`);
      }
      const password = existingMailbox?.mailPassword
        ? decryptSecret(existingMailbox.mailPassword)
        : generateMailPassword();

      const encryptedPassword = encryptSecret(password);
      const currentPrimary = await tx.mailboxAccount.findFirst({
        where: { userId, isPrimary: true },
        select: { id: true },
      });
      const makePrimary = options?.makePrimary !== false || !currentPrimary;
      if (makePrimary) {
        await tx.mailboxAccount.updateMany({ where: { userId }, data: { isPrimary: false } });
      }

      const mailbox = await tx.mailboxAccount.upsert({
        where: { username: stalwartName },
        update: {
          mailPassword: encryptedPassword,
          ...(makePrimary ? { isPrimary: true } : {}),
        },
        create: {
          userId,
          username: stalwartName,
          mailPassword: encryptedPassword,
          isPrimary: makePrimary,
        },
        select: { id: true },
      });

      const primary = makePrimary
        ? { id: mailbox.id, mailPassword: encryptedPassword }
        : await tx.mailboxAccount.findFirst({
          where: { userId, isPrimary: true },
          select: { id: true, mailPassword: true },
        });
      if (!primary) throw new Error('Mailbox primary invariant could not be established');
      await tx.user.update({
        where: { id: userId },
        data: { mailPassword: primary.mailPassword },
      });
      return password;
    }, { timeout: 30_000 });
    // The trigger-created task is durable before Stalwart is touched. An
    // ambiguous timeout leaves the task queued and an idempotent retry repairs
    // the external principal from current database desired state.
    await requireMailboxReconciled(stalwartName);
    return password;
  } catch (error) {
    console.error(`[userMail] Failed to provision mailbox for '${stalwartName}':`, error);
    throw error;
  }
}

async function deleteMailboxAccount(username: string, expectedUserId?: string): Promise<void> {
  const stalwartName = normalizeMailboxUsername(username);
  if (!stalwartName) throw new Error('Mailbox username is required');
  if (isReservedSystemMailboxUsername(stalwartName)) {
    throw new Error(`Refusing to delete reserved system mailbox '${stalwartName}' through user mailbox cleanup`);
  }

  try {
    const deletedDesiredRow = await prisma.$transaction(async (tx) => {
      await lockMailboxUsername(tx, stalwartName);
      const existing = await tx.mailboxAccount.findUnique({
        where: { username: stalwartName },
        select: { id: true, userId: true },
      });
      if (expectedUserId && existing && existing.userId !== expectedUserId) {
        throw new Error(`Mailbox '${stalwartName}' is owned by a different Portal user`);
      }
      if (existing) await lockUserMailboxRows(tx, existing.userId);
      if (!existing) return false;
      const deleted = await tx.mailboxAccount.deleteMany({
        where: { id: existing.id, userId: expectedUserId || existing.userId },
      });
      if (deleted.count !== 1) throw new Error('Mailbox account changed while it was being deleted');

      let primary = await tx.mailboxAccount.findFirst({
        where: { userId: existing.userId, isPrimary: true },
        select: { id: true, mailPassword: true },
      });
      if (!primary) {
        const replacement = await tx.mailboxAccount.findFirst({
          where: { userId: existing.userId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, mailPassword: true },
        });
        if (replacement) {
          await tx.mailboxAccount.update({
            where: { id: replacement.id },
            data: { isPrimary: true },
          });
          primary = replacement;
        }
      }

      await tx.user.update({
        where: { id: existing.userId },
        data: { mailPassword: primary?.mailPassword ?? null },
      });
      return true;
    }, { timeout: 30_000 });

    // Cascading user deletion removes MailboxAccount before cleanup runs. Its
    // DB trigger already leaves a task tombstone; explicitly enqueue when the
    // desired row was gone before this call so cleanup remains durable too.
    if (!deletedDesiredRow) await enqueueMailboxReconciliation(stalwartName);
    await requireMailboxReconciled(stalwartName);
  } catch (error) {
    console.error(`[userMail] Failed to delete mailbox for '${stalwartName}':`, error);
    throw error;
  }
}

export async function deleteUserMailbox(username: string): Promise<void> {
  await deleteMailboxAccount(username);
}

export async function deleteUserMailboxByUserId(username: string, userId: string): Promise<void> {
  await deleteMailboxAccount(username, userId);
}

export async function getUserMailAccounts(userId: string): Promise<Array<{
  id: string;
  username: string;
  password: string;
  isPrimary: boolean;
}>> {
  await ensureLegacyMailboxMigrated(userId);

  let user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      username: true,
      mailboxAccounts: {
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        select: { id: true, username: true, mailPassword: true, isPrimary: true },
      },
    },
  });

  if (!user) {
    return [];
  }

  if (user.mailboxAccounts.length === 0 && user.username) {
    try {
      await provisionUserMailbox(user.username, userId, { makePrimary: true });
      user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          username: true,
          mailboxAccounts: {
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            select: { id: true, username: true, mailPassword: true, isPrimary: true },
          },
        },
      });
    } catch (error) {
      console.error(`[userMail] Auto-provision failed for user ${userId}:`, error);
    }
  }

  // Do not hand credentials to JMAP callers while the corresponding Stalwart
  // principal is only desired/queued. This makes degraded mail state explicit
  // instead of returning credentials that are not yet usable.
  for (const mailbox of user?.mailboxAccounts || []) {
    await requireMailboxReconciled(mailbox.username);
  }

  return (user?.mailboxAccounts || [])
    .filter((mailbox) => !isReservedSystemMailboxUsername(mailbox.username))
    .map((mailbox) => ({
      id: mailbox.id,
      username: mailbox.username,
      password: decryptSecret(mailbox.mailPassword),
      isPrimary: mailbox.isPrimary,
    }));
}

export async function getUserMailCredentials(
  userId: string,
  accountId?: string
): Promise<{ accountId: string; username: string; password: string; isPrimary: boolean } | null> {
  const accounts = await getUserMailAccounts(userId);
  if (!accounts.length) {
    return null;
  }

  const selected = accountId
    ? accounts.find((account) => account.id === accountId)
    : accounts.find((account) => account.isPrimary) || accounts[0];

  if (!selected) {
    return null;
  }

  return {
    accountId: selected.id,
    username: selected.username,
    password: selected.password,
    isPrimary: selected.isPrimary,
  };
}

export async function getProvisionedMailboxes(): Promise<Array<{
  userId: string;
  username: string;
  email: string;
  createdAt: Date;
  lastLoginAt: Date | null;
}>> {
  const accounts = await prisma.mailboxAccount.findMany({
    include: {
      user: {
        select: {
          id: true,
          lastLoginAt: true,
        },
      },
    },
    orderBy: [{ username: 'asc' }],
  });

  return accounts.map((account) => ({
    userId: account.user.id,
    username: account.username,
    email: `${account.username}@${getMailDomain()}`,
    createdAt: account.createdAt,
    lastLoginAt: account.user.lastLoginAt,
  }));
}
