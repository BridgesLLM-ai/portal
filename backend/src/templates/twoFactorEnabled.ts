/**
 * Two-Factor Authentication Enabled email template
 */
import { baseTemplate, type EmailBranding } from './baseTemplate';

const MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'localhost';
const SUPPORT_EMAIL = `support@${MAIL_DOMAIN}`;

export function twoFactorEnabledHtml(username: string, method?: string, branding?: EmailBranding): string {
  const name = branding?.portalName || 'BridgesLLM';
  const methodLabel = method === 'email' ? 'email verification' : 'authenticator app';

  const content = `
    <h2 style="margin:0 0 16px; font-size:22px; font-weight:700; color:#ffffff;">Two-factor authentication enabled &#128274;</h2>
    <p style="margin:0 0 20px; font-size:15px; color:#94a3b8; line-height:1.6;">
      Hi <strong style="color:#e2e8f0;">${username}</strong>, two-factor authentication has been successfully enabled on your ${name} account.
    </p>
    <!-- Success indicator -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px; border-radius:10px; background-color:#0a0f1e; border:1px solid #1e293b;">
      <tr>
        <td style="padding:16px 20px;">
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr>
              <td style="width:12px; height:12px; border-radius:6px; background-color:#10b981; vertical-align:middle;"></td>
              <td style="padding-left:12px; vertical-align:middle;">
                <p style="margin:0; font-size:14px; color:#e2e8f0; font-weight:600;">2FA is now active</p>
              </td>
            </tr>
          </table>
          <p style="margin:12px 0 0; font-size:13px; color:#94a3b8; line-height:1.5;">
            You'll be asked for a verification code via ${methodLabel} each time you sign in.
          </p>
        </td>
      </tr>
    </table>
    <!-- Backup codes reminder -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px; border-radius:10px; background-color:#1a1510; border:1px solid #78350f;">
      <tr>
        <td style="padding:16px 20px; border-left:3px solid #f59e0b; border-radius:10px;">
          <p style="margin:0 0 8px; font-size:14px; color:#fbbf24; font-weight:600;">
            &#9888;&#65039; Save your backup codes
          </p>
          <p style="margin:0; font-size:13px; color:#94a3b8; line-height:1.5;">
            Make sure you've saved your backup codes in a secure location. If you lose access to your ${methodLabel}, these are your emergency fallback.
          </p>
        </td>
      </tr>
    </table>
    <!-- Recovery info -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px;">
      <tr>
        <td style="padding:16px; background-color:#0a0f1e; border:1px solid #1e293b; border-radius:8px;">
          <p style="margin:0; font-size:12px; color:#64748b; line-height:1.5;">
            <strong style="color:#94a3b8;">Lost your backup codes?</strong> Contact your agent directly through Discord or Slack and request an account unlock. Your agent can verify your identity and disable 2FA for you.
          </p>
        </td>
      </tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td style="border-top:1px solid #1e293b; padding-top:20px;">
          <p style="margin:0; font-size:13px; color:#64748b; line-height:1.5;">
            If you didn't enable 2FA, someone may have access to your account. Change your password immediately and contact <a href="mailto:${SUPPORT_EMAIL}" style="color:#94a3b8; text-decoration:underline;">${SUPPORT_EMAIL}</a>.
          </p>
        </td>
      </tr>
    </table>
  `;

  return baseTemplate(content, `Two-factor authentication has been enabled on your ${name} account`, branding);
}

export function twoFactorEnabledText(username: string, method?: string, branding?: EmailBranding): string {
  const name = branding?.portalName || 'BridgesLLM';
  const methodLabel = method === 'email' ? 'email verification' : 'authenticator app';
  return `Two-factor authentication enabled

Hi ${username}, two-factor authentication has been successfully enabled on your ${name} account.

You'll be asked for a verification code via ${methodLabel} each time you sign in.

IMPORTANT: Make sure you've saved your backup codes in a secure location. If you lose access to your ${methodLabel}, these are your emergency fallback.

Lost your backup codes? Contact your agent directly through Discord or Slack and request an account unlock. Your agent can verify your identity and disable 2FA for you.

If you didn't enable 2FA, someone may have access to your account. Change your password immediately and contact ${SUPPORT_EMAIL}.

— ${name}`;
}
