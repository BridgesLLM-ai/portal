/**
 * Two-Factor Authentication Disabled email template
 */
import { baseTemplate, type EmailBranding } from './baseTemplate';

const MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'localhost';
const SUPPORT_EMAIL = `support@${MAIL_DOMAIN}`;

export function twoFactorDisabledHtml(username: string, branding?: EmailBranding): string {
  const name = branding?.portalName || 'BridgesLLM';
  const timestamp = new Date().toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const content = `
    <h2 style="margin:0 0 16px; font-size:22px; font-weight:700; color:#ffffff;">Two-factor authentication disabled</h2>
    <p style="margin:0 0 20px; font-size:15px; color:#94a3b8; line-height:1.6;">
      Hi <strong style="color:#e2e8f0;">${username}</strong>, two-factor authentication has been removed from your ${name} account.
    </p>
    <!-- Warning bar -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;">
      <tr>
        <td style="height:3px; border-radius:2px; background-color:#ef4444;"></td>
      </tr>
    </table>
    <!-- Details card -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px; border-radius:10px; background-color:#0a0f1e; border:1px solid #1e293b;">
      <tr>
        <td style="padding:16px 20px; border-bottom:1px solid #1e293b;">
          <p style="margin:0 0 4px; font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:0.5px;">Status</p>
          <p style="margin:0; font-size:14px; color:#ef4444; font-weight:600;">2FA Disabled</p>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 20px;">
          <p style="margin:0 0 4px; font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:0.5px;">Disabled at</p>
          <p style="margin:0; font-size:14px; color:#e2e8f0;">${timestamp}</p>
        </td>
      </tr>
    </table>
    <!-- Security recommendation -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px; border-radius:10px; background-color:#1a1010; border:1px solid #7f1d1d;">
      <tr>
        <td style="padding:16px 20px; border-left:3px solid #ef4444; border-radius:10px;">
          <p style="margin:0 0 8px; font-size:14px; color:#fca5a5; font-weight:600;">
            Your account is less secure
          </p>
          <p style="margin:0; font-size:13px; color:#94a3b8; line-height:1.5;">
            Without two-factor authentication, your account relies solely on your password for protection. We strongly recommend re-enabling 2FA for maximum security.
          </p>
        </td>
      </tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td style="border-top:1px solid #1e293b; padding-top:20px;">
          <p style="margin:0; font-size:13px; color:#64748b; line-height:1.5;">
            If you didn't make this change, your account may be compromised. Change your password immediately and contact <a href="mailto:${SUPPORT_EMAIL}" style="color:#94a3b8; text-decoration:underline;">${SUPPORT_EMAIL}</a>.
          </p>
        </td>
      </tr>
    </table>
  `;

  return baseTemplate(content, `Two-factor authentication has been disabled on your ${name} account`, branding);
}

export function twoFactorDisabledText(username: string, branding?: EmailBranding): string {
  const name = branding?.portalName || 'BridgesLLM';
  return `Two-factor authentication disabled

Hi ${username}, two-factor authentication has been removed from your ${name} account.

Your account is now less secure. Without two-factor authentication, your account relies solely on your password for protection. We strongly recommend re-enabling 2FA for maximum security.

If you didn't make this change, your account may be compromised. Change your password immediately and contact ${SUPPORT_EMAIL}.

— ${name}`;
}
