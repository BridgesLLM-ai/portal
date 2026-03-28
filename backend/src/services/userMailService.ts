/**
 * User Mail Provisioning Service
 *
 * Mailboxes are first-class user-owned accounts, not just a single field on User.
 * A user may have multiple personal mailboxes over time; one is marked primary.
 */

import crypto from 'crypto';
import { prisma } from '../config/database';

function getStalwartUrl() { return process.env.STALWART_URL || 'http://127.0.0.1:8580'; }
function getStalwartAdminPass() { return process.env.STALWART_ADMIN_PASS || ''; }
const STALWART_ADMIN_USER = 'admin';
function getMailDomain() { return process.env.MAIL_DOMAIN || 'localhost'; }

function adminAuthHeader(): string {
  return 'Basic ' + Buffer.from(`${STALWART_ADMIN_USER}:${getStalwartAdminPass()}`).toString('base64');
}

function normalizeMailboxUsername(username: string): string {
  return username.trim().toLowerCase();
}

function generateMailPassword(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(32);
  let password = '';
  for (let i = 0; i < 32; i++) {
    password += chars[bytes[i] % chars.length];
  }
  return password;
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
  await prisma.mailboxAccount.upsert({
    where: { username: normalized },
    update: {
      userId,
      mailPassword: user.mailPassword,
      isPrimary: true,
    },
    create: {
      userId,
      username: normalized,
      mailPassword: user.mailPassword,
      isPrimary: true,
    },
  });
}

async function setPrimaryMailbox(userId: string, mailboxId: string): Promise<void> {
  await prisma.$transaction([
    prisma.mailboxAccount.updateMany({
      where: { userId },
      data: { isPrimary: false },
    }),
    prisma.mailboxAccount.update({
      where: { id: mailboxId },
      data: { isPrimary: true },
    }),
  ]);
}

export async function provisionUserMailbox(
  username: string,
  userId: string,
  options?: { makePrimary?: boolean }
): Promise<string> {
  const stalwartName = normalizeMailboxUsername(username);
  const email = `${stalwartName}@${getMailDomain()}`;

  // If this user already has a DB record with a password, reuse it to avoid
  // Stalwart/DB password drift from partial failures.
  const existingMailbox = await prisma.mailboxAccount.findUnique({
    where: { username: stalwartName },
    select: { mailPassword: true },
  });
  const password = existingMailbox?.mailPassword || generateMailPassword();

  try {
    const createRes = await fetch(`${getStalwartUrl()}/api/principal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': adminAuthHeader(),
      },
      body: JSON.stringify({
        type: 'individual',
        name: stalwartName,
        secrets: [password],
        emails: [email],
        roles: ['user'],
        quota: 1073741824,
      }),
    });

    if (createRes.status === 409) {
      console.log(`[userMail] Account '${stalwartName}' already exists, updating password`);
      const patchRes = await fetch(`${getStalwartUrl()}/api/principal/${stalwartName}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': adminAuthHeader(),
        },
        body: JSON.stringify([
          { action: 'set', field: 'secrets', value: [password] },
        ]),
      });
      if (!patchRes.ok) {
        const text = await patchRes.text();
        throw new Error(`Failed to update Stalwart account '${stalwartName}': ${patchRes.status} ${text}`);
      }
    } else if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`Failed to create Stalwart account '${stalwartName}': ${createRes.status} ${text}`);
    } else {
      console.log(`[userMail] Created Stalwart account: ${stalwartName}@${getMailDomain()}`);
    }

    const mailbox = await prisma.mailboxAccount.upsert({
      where: { username: stalwartName },
      update: {
        userId,
        mailPassword: password,
      },
      create: {
        userId,
        username: stalwartName,
        mailPassword: password,
        isPrimary: false,
      },
      select: { id: true },
    });

    if (options?.makePrimary !== false) {
      await setPrimaryMailbox(userId, mailbox.id);
    }

    await prisma.user.update({
      where: { id: userId },
      data: { mailPassword: password },
    });

    return password;
  } catch (error) {
    console.error(`[userMail] Failed to provision mailbox for '${stalwartName}':`, error);
    throw error;
  }
}

export async function deleteUserMailbox(username: string): Promise<void> {
  const stalwartName = normalizeMailboxUsername(username);

  try {
    const res = await fetch(`${getStalwartUrl()}/api/principal/${stalwartName}`, {
      method: 'DELETE',
      headers: {
        'Authorization': adminAuthHeader(),
      },
    });

    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      throw new Error(`Failed to delete Stalwart account '${stalwartName}': ${res.status} ${text}`);
    }

    console.log(`[userMail] Deleted Stalwart account: ${stalwartName}`);
  } catch (error) {
    console.error(`[userMail] Failed to delete mailbox for '${stalwartName}':`, error);
    throw error;
  }

  await prisma.mailboxAccount.deleteMany({ where: { username: stalwartName } }).catch((error) => {
    console.error(`[userMail] Failed to delete mailbox account row for '${stalwartName}':`, error);
  });
}

export async function deleteUserMailboxByUserId(username: string, userId: string): Promise<void> {
  await deleteUserMailbox(username);

  const primary = await prisma.mailboxAccount.findFirst({
    where: { userId },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    select: { mailPassword: true },
  });

  await prisma.user.update({
    where: { id: userId },
    data: { mailPassword: primary?.mailPassword ?? null },
  });
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

  return (user?.mailboxAccounts || []).map((mailbox) => ({
    id: mailbox.id,
    username: mailbox.username,
    password: mailbox.mailPassword,
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
