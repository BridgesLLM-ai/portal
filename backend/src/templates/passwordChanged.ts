/**
 * Password Changed confirmation email template
 */
import { baseTemplate, type EmailBranding } from './baseTemplate';

const MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'localhost';
const SUPPORT_EMAIL = `support@${MAIL_DOMAIN}`;

export function passwordChangedHtml(username: string, changedAt: Date, branding?: EmailBranding): string {
  const name = branding?.portalName || 'BridgesLLM';
  const timestamp = changedAt.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const content = `
    <h2 style="margin:0 0 16px; font-size:22px; font-weight:700; color:#ffffff;">Your password has been changed</h2>
    <p style="margin:0 0 20px; font-size:15px; color:#94a3b8; line-height:1.6;">
      Hi <strong style="color:#e2e8f0;">${username}</strong>, the password for your ${name} account was successfully changed.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px; border-radius:10px; background-color:#0a0f1e; border:1px solid #1e293b;">
      <tr>
        <td style="padding:16px 20px;">
          <p style="margin:0 0 4px; font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:0.5px;">Changed at</p>
          <p style="margin:0; font-size:14px; color:#e2e8f0;">${timestamp}</p>
        </td>
      </tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td style="border-top:1px solid #1e293b; padding-top:20px;">
          <p style="margin:0 0 8px; font-size:14px; color:#ef4444; font-weight:600;">
            Didn't make this change?
          </p>
          <p style="margin:0; font-size:13px; color:#94a3b8; line-height:1.5;">
            If you didn't change your password, your account may be compromised. Please contact support immediately at <a href="mailto:${SUPPORT_EMAIL}" style="color:#94a3b8; text-decoration:underline;">${SUPPORT_EMAIL}</a>.
          </p>
        </td>
      </tr>
    </table>
  `;

  return baseTemplate(content, `Your ${name} password was changed`, branding);
}

export function passwordChangedText(username: string, changedAt: Date, branding?: EmailBranding): string {
  const name = branding?.portalName || 'BridgesLLM';
  const timestamp = changedAt.toISOString();
  return `Your password has been changed

Hi ${username}, the password for your ${name} account was successfully changed.

Changed at: ${timestamp}

If you didn't make this change, your account may be compromised. Please contact support immediately at ${SUPPORT_EMAIL}.

— ${name}`;
}
