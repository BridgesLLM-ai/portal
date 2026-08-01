/**
 * Cron Jobs - Scheduled Tasks
 * 
 * Scheduled background tasks.
 * Add any new scheduled tasks here.
 */

import cron from 'node-cron';
import { prisma } from './config/database';
import { syncAutoForwardRule } from './services/mailService';
import { decryptSecret } from './utils/authSecrets';
import { getPortalFeatureCapabilities } from './utils/portalFeatureCapabilities';

export async function syncConfiguredAutoForwardRules(): Promise<void> {
  // Tailnet/local origin modes cannot operate mail. Keep the capability guard
  // ahead of mailbox discovery and secret decryption, not merely the JMAP call.
  if (!getPortalFeatureCapabilities().mail.available) return;

  const accounts = await prisma.mailboxAccount.findMany({
    select: {
      username: true,
      mailPassword: true,
      autoForwardTo: true,
    },
  });

  let synced = 0;
  for (const account of accounts) {
    try {
      await syncAutoForwardRule(account.autoForwardTo, account.username, decryptSecret(account.mailPassword));
      synced++;
    } catch (error: any) {
      console.error(`[mail] Failed to sync server-side auto-forwarding for ${account.username}:`, error.message);
    }
  }

  if (synced > 0) {
    console.log(`[mail] Synced server-side auto-forwarding for ${synced} mailbox account(s)`);
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

export function initializeCronJobs() {
  console.log('🕐 Initializing cron jobs...');
  syncConfiguredAutoForwardRules().catch((error) => {
    console.error('[mail] Failed to sync server-side auto-forwarding:', error.message);
  });
  console.log('✅ Cron jobs initialized');
}

export function shutdownCronJobs() {
  console.log('🛑 Shutting down cron jobs...');
  cron.getTasks().forEach(task => task.stop());
}
