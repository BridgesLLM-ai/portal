/**
 * Login Alert email template — sent when login from a new IP is detected
 */
import { baseTemplate, type EmailBranding } from './baseTemplate';

const MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'localhost';
const SUPPORT_EMAIL = `support@${MAIL_DOMAIN}`;

interface LoginMeta {
  ip: string;
  geo: string;
  device: string;
  timestamp: Date;
}

export function loginAlertHtml(username: string, meta: LoginMeta, branding?: EmailBranding): string {
  const name = branding?.portalName || 'BridgesLLM';
  const timestamp = meta.timestamp.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const content = `
    <h2 style="margin:0 0 16px; font-size:22px; font-weight:700; color:#ffffff;">New login detected</h2>
    <p style="margin:0 0 20px; font-size:15px; color:#94a3b8; line-height:1.6;">
      Hi <strong style="color:#e2e8f0;">${username}</strong>, we noticed a new sign-in to your ${name} account.
    </p>
    <!-- Warning accent bar -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;">
      <tr>
        <td style="height:3px; border-radius:2px; background-color:#f59e0b;"></td>
      </tr>
    </table>
    <!-- Login details -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px; border-radius:10px; background-color:#0a0f1e; border:1px solid #1e293b;">
      <tr>
        <td style="padding:16px 20px; border-bottom:1px solid #1e293b;">
          <p style="margin:0 0 4px; font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:0.5px;">Time</p>
          <p style="margin:0; font-size:14px; color:#e2e8f0;">${timestamp}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 20px; border-bottom:1px solid #1e293b;">
          <p style="margin:0 0 4px; font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:0.5px;">IP Address</p>
          <p style="margin:0; font-size:14px; color:#e2e8f0;">${meta.ip}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 20px; border-bottom:1px solid #1e293b;">
          <p style="margin:0 0 4px; font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:0.5px;">Location</p>
          <p style="margin:0; font-size:14px; color:#e2e8f0;">${meta.geo || 'Unknown'}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 20px;">
          <p style="margin:0 0 4px; font-size:12px; color:#64748b; text-transform:uppercase; letter-spacing:0.5px;">Device</p>
          <p style="margin:0; font-size:14px; color:#e2e8f0;">${meta.device || 'Unknown'}</p>
        </td>
      </tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td style="border-top:1px solid #1e293b; padding-top:20px;">
          <p style="margin:0 0 8px; font-size:14px; color:#f59e0b; font-weight:600;">
            Wasn't you?
          </p>
          <p style="margin:0; font-size:13px; color:#94a3b8; line-height:1.5;">
            If you don't recognize this login, change your password immediately and contact <a href="mailto:${SUPPORT_EMAIL}" style="color:#94a3b8; text-decoration:underline;">${SUPPORT_EMAIL}</a>.
          </p>
        </td>
      </tr>
    </table>
  `;

  return baseTemplate(content, `New login to your ${name} account`, branding);
}

export function loginAlertText(username: string, meta: LoginMeta, branding?: EmailBranding): string {
  const name = branding?.portalName || 'BridgesLLM';
  return `New login detected

Hi ${username}, we noticed a new sign-in to your ${name} account.

Time: ${meta.timestamp.toISOString()}
IP Address: ${meta.ip}
Location: ${meta.geo || 'Unknown'}
Device: ${meta.device || 'Unknown'}

If you don't recognize this login, change your password immediately and contact ${SUPPORT_EMAIL}.

— ${name}`;
}
