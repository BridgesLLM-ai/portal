/**
 * Notification Service — centralized email notification dispatch via Stalwart JMAP
 * 
 * Uses mailService.sendEmail() for all sends (JMAP/Stalwart).
 * All system notifications come from noreply@${MAIL_DOMAIN}.
 * Does NOT replace nodemailer email.ts — that's for cron/agent jobs.
 * 
 * Loads portal branding (name, logo, accent color) from the database
 * so emails reflect the portal owner's customization.
 */

import { sendEmail, sendSystemAlert } from './mailService';
import { prisma } from '../config/database';
import { getCachedBranding } from '../templates/baseTemplate';
import { passwordResetHtml, passwordResetText } from '../templates/passwordReset';
import { passwordChangedHtml, passwordChangedText } from '../templates/passwordChanged';
import { welcomeHtml, welcomeText } from '../templates/welcome';
import { loginAlertHtml, loginAlertText } from '../templates/loginAlert';
import { twoFactorEnabledHtml, twoFactorEnabledText } from '../templates/twoFactorEnabled';
import { twoFactorDisabledHtml, twoFactorDisabledText } from '../templates/twoFactorDisabled';
import { twoFactorCodeHtml, twoFactorCodeText } from '../templates/twoFactorCode';
import { shareLinkHtml, shareLinkText, type ShareLinkEmailParams } from '../templates/shareLink';

const MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'localhost';

async function isNotificationEnabled(key: string, defaultValue = false): Promise<boolean> {
  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key } });
    if (!setting) return defaultValue;
    return setting.value === 'true';
  } catch {
    return defaultValue;
  }
}

/**
 * Send a welcome email to a newly registered user
 */
export async function sendWelcomeEmail(user: { email: string; username: string }): Promise<void> {
  try {
    const branding = await getCachedBranding();
    await sendEmail({
      from: `noreply@${MAIL_DOMAIN}`,
      fromName: branding.portalName,
      to: [{ name: user.username, email: user.email }],
      subject: `Welcome to ${branding.portalName}!`,
      htmlBody: welcomeHtml(user.username, branding),
      textBody: welcomeText(user.username, branding),
    });
  } catch (err) {
    console.error('[notificationService] Failed to send welcome email:', err);
  }
}

/**
 * Send password changed confirmation email
 */
export async function sendPasswordChangedEmail(user: { email: string; username: string }): Promise<void> {
  try {
    if (!(await isNotificationEnabled('notifications.passwordChange'))) return;
    const branding = await getCachedBranding();
    await sendEmail({
      from: `noreply@${MAIL_DOMAIN}`,
      fromName: branding.portalName,
      to: [{ name: user.username, email: user.email }],
      subject: `Your ${branding.portalName} password has been changed`,
      htmlBody: passwordChangedHtml(user.username, new Date(), branding),
      textBody: passwordChangedText(user.username, new Date(), branding),
    });
  } catch (err) {
    console.error('[notificationService] Failed to send password changed email:', err);
  }
}

/**
 * Send password reset email with reset link
 */
export async function sendPasswordResetEmail(user: { email: string }, resetUrl: string): Promise<void> {
  try {
    const branding = await getCachedBranding();
    await sendEmail({
      from: `noreply@${MAIL_DOMAIN}`,
      fromName: branding.portalName,
      to: [{ email: user.email }],
      subject: `Reset your ${branding.portalName} password`,
      htmlBody: passwordResetHtml(resetUrl, branding),
      textBody: passwordResetText(resetUrl, branding),
    });
  } catch (err) {
    console.error('[notificationService] Failed to send password reset email:', err);
  }
}

/**
 * Send login alert email (new IP detected)
 */
export async function sendLoginAlertEmail(
  user: { email: string; username: string },
  meta: { ip: string; geo: string; device: string; timestamp: Date }
): Promise<void> {
  try {
    if (!(await isNotificationEnabled('notifications.newDeviceLogin'))) return;
    const branding = await getCachedBranding();
    await sendEmail({
      from: `noreply@${MAIL_DOMAIN}`,
      fromName: branding.portalName,
      to: [{ name: user.username, email: user.email }],
      subject: `New login to your ${branding.portalName} account`,
      htmlBody: loginAlertHtml(user.username, meta, branding),
      textBody: loginAlertText(user.username, meta, branding),
    });
  } catch (err) {
    console.error('[notificationService] Failed to send login alert email:', err);
  }
}

/**
 * Send 2FA enabled confirmation email
 */
export async function sendTwoFactorEnabledEmail(user: { email: string; username: string }, method?: string): Promise<void> {
  try {
    const branding = await getCachedBranding();
    await sendEmail({
      from: `noreply@${MAIL_DOMAIN}`,
      fromName: branding.portalName,
      to: [{ name: user.username, email: user.email }],
      subject: `Two-factor authentication enabled on your ${branding.portalName} account`,
      htmlBody: twoFactorEnabledHtml(user.username, method, branding),
      textBody: twoFactorEnabledText(user.username, method, branding),
    });
  } catch (err) {
    console.error('[notificationService] Failed to send 2FA enabled email:', err);
  }
}

/**
 * Send 2FA disabled warning email
 */
export async function sendTwoFactorDisabledEmail(user: { email: string; username: string }): Promise<void> {
  try {
    const branding = await getCachedBranding();
    await sendEmail({
      from: `noreply@${MAIL_DOMAIN}`,
      fromName: branding.portalName,
      to: [{ name: user.username, email: user.email }],
      subject: `Two-factor authentication disabled on your ${branding.portalName} account`,
      htmlBody: twoFactorDisabledHtml(user.username, branding),
      textBody: twoFactorDisabledText(user.username, branding),
    });
  } catch (err) {
    console.error('[notificationService] Failed to send 2FA disabled email:', err);
  }
}

/**
 * Send a two-factor verification code email
 */
export async function sendTwoFactorCodeEmail(user: { email: string }, code: string): Promise<void> {
  try {
    const branding = await getCachedBranding();
    await sendEmail({
      from: `noreply@${MAIL_DOMAIN}`,
      fromName: branding.portalName,
      to: [{ email: user.email }],
      subject: `Your ${branding.portalName} verification code`,
      htmlBody: twoFactorCodeHtml(code, branding),
      textBody: twoFactorCodeText(code, branding),
    });
  } catch (err) {
    console.error('[notificationService] Failed to send 2FA code email:', err);
  }
}

/**
 * Send a share link email from the portal user to an external recipient.
 * Uses the sender's own Stalwart mailbox (username@${MAIL_DOMAIN}) if credentials
 * are available; falls back to noreply with Reply-To set to the sender's address.
 */
export async function sendShareLinkEmail(
  params: ShareLinkEmailParams,
  mailCreds: { username: string; password: string } | null,
): Promise<void> {
  const branding = await getCachedBranding();
  const senderUsername = params.senderName;
  const senderEmail = params.senderEmail;

  if (mailCreds) {
    // Send from the user's own mailbox
    const fromEmail = `${mailCreds.username}@${MAIL_DOMAIN}`;
    await sendEmail(
      {
        from: fromEmail,
        fromName: senderUsername,
        to: [{ email: params.recipientEmail as string }],
        subject: `${senderUsername} shared "${params.appName}" with you`,
        htmlBody: shareLinkHtml(params, branding),
        textBody: shareLinkText(params, branding),
      },
      mailCreds.username,
      mailCreds.password,
    );
  } else {
    // Fallback: noreply with Reply-To
    await sendEmail({
      from: `noreply@${MAIL_DOMAIN}`,
      fromName: `${senderUsername} via ${branding.portalName}`,
      to: [{ email: params.recipientEmail as string }],
      replyToAddresses: [{ name: senderUsername, email: senderEmail }],
      subject: `${senderUsername} shared "${params.appName}" with you`,
      htmlBody: shareLinkHtml(params, branding),
      textBody: shareLinkText(params, branding),
    });
  }
}

/**
 * Send admin alert email — wraps sendSystemAlert for admin notifications
 */
export async function sendAdminAlertEmail(admins: string[], subject: string, body: string): Promise<void> {
  try {
    await sendSystemAlert(admins, subject, body);
  } catch (err) {
    console.error('[notificationService] Failed to send admin alert email:', err);
  }
}
