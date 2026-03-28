/**
 * Password Reset email template
 */
import { baseTemplate, type EmailBranding } from './baseTemplate';

export function passwordResetHtml(resetUrl: string, branding?: EmailBranding): string {
  const name = branding?.portalName || 'BridgesLLM';
  const accent = branding?.accentColor || '#10b981';

  const content = `
    <h2 style="margin:0 0 16px; font-size:22px; font-weight:700; color:#ffffff;">Reset your password</h2>
    <p style="margin:0 0 24px; font-size:15px; color:#94a3b8; line-height:1.6;">
      We received a request to reset the password for your ${name} account. Click the button below to choose a new password.
    </p>
    <!-- Button -->
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
      <tr>
        <td align="center" style="border-radius:12px;">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" style="height:48px;v-text-anchor:middle;width:200px;" arcsize="25%" fillcolor="${accent}" strokeweight="0">
            <w:anchorlock/>
            <center style="color:#ffffff;font-weight:600;font-size:15px;font-family:Arial,sans-serif;">Reset Password</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-->
          <a href="${resetUrl}" target="_blank" style="display:inline-block; padding:14px 36px; font-size:15px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:12px; background-color:${accent};">
            Reset Password
          </a>
          <!--<![endif]-->
        </td>
      </tr>
    </table>
    <p style="margin:0 0 8px; font-size:13px; color:#94a3b8; line-height:1.5;">
      This link will expire in <strong style="color:#e2e8f0;">1 hour</strong>.
    </p>
    <p style="margin:0 0 20px; font-size:13px; color:#94a3b8; line-height:1.5;">
      If the button doesn't work, copy and paste this URL into your browser:
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px;">
      <tr>
        <td style="padding:12px; border-radius:8px; background-color:#0a0f1e; border:1px solid #1e293b;">
          <p style="margin:0; font-size:12px; color:#94a3b8; word-break:break-all; line-height:1.5;">
            ${resetUrl}
          </p>
        </td>
      </tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td style="border-top:1px solid #1e293b; padding-top:20px;">
          <p style="margin:0; font-size:13px; color:#64748b; line-height:1.5;">
            If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.
          </p>
        </td>
      </tr>
    </table>
  `;

  return baseTemplate(content, `Reset your ${name} password`, branding);
}

export function passwordResetText(resetUrl: string, branding?: EmailBranding): string {
  const name = branding?.portalName || 'BridgesLLM';
  return `Reset your password

We received a request to reset the password for your ${name} account.

Click this link to reset your password:
${resetUrl}

This link will expire in 1 hour.

If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.

— ${name}`;
}
