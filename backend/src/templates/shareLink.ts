/**
 * Share Link email template
 * Sent when a portal user shares an app link with someone via email.
 */
import { baseTemplate, type EmailBranding } from './baseTemplate';

export interface ShareLinkEmailParams {
  senderName: string;
  senderEmail: string;
  recipientEmail: string;
  appName: string;
  shareUrl: string;
  isPasswordProtected: boolean;
  password?: string;
}

export function shareLinkHtml(params: ShareLinkEmailParams, branding?: EmailBranding): string {
  const portalName = branding?.portalName || 'BridgesLLM';
  const accent = branding?.accentColor || '#6366f1';
  const { senderName, appName, shareUrl, isPasswordProtected, password } = params;

  const passwordBlock = isPasswordProtected && password
    ? `
    <!-- Password box -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px;">
      <tr>
        <td style="padding:16px 20px; border-radius:10px; background-color:#0a0f1e; border:1px solid #334155; border-left:3px solid ${accent};">
          <p style="margin:0 0 6px; font-size:11px; font-weight:600; color:#94a3b8; text-transform:uppercase; letter-spacing:0.08em;">Password Required</p>
          <p style="margin:0 0 8px; font-size:13px; color:#94a3b8; line-height:1.5;">
            This app is password-protected. Use the password below to access it:
          </p>
          <p style="margin:0; font-size:18px; font-weight:700; color:#ffffff; letter-spacing:0.1em; font-family:'Courier New',Courier,monospace;">${password}</p>
        </td>
      </tr>
    </table>`
    : isPasswordProtected
    ? `
    <!-- Password note (no password provided) -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px;">
      <tr>
        <td style="padding:14px 18px; border-radius:10px; background-color:#0a0f1e; border:1px solid #334155;">
          <p style="margin:0; font-size:13px; color:#94a3b8; line-height:1.5;">
            &#128274; This app is <strong style="color:#fbbf24;">password-protected</strong>. Ask <strong style="color:#e2e8f0;">${senderName}</strong> for the password.
          </p>
        </td>
      </tr>
    </table>`
    : '';

  const content = `
    <!-- Sender info -->
    <p style="margin:0 0 6px; font-size:12px; font-weight:600; color:#64748b; text-transform:uppercase; letter-spacing:0.08em;">Shared with you</p>
    <h2 style="margin:0 0 8px; font-size:22px; font-weight:700; color:#ffffff; line-height:1.3;">
      ${senderName} shared an app with you
    </h2>
    <p style="margin:0 0 24px; font-size:15px; color:#94a3b8; line-height:1.6;">
      <strong style="color:#e2e8f0;">${senderName}</strong> invited you to access <strong style="color:#e2e8f0;">${appName}</strong> via ${portalName}.
    </p>

    <!-- App card -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px;">
      <tr>
        <td style="padding:18px 20px; border-radius:12px; background-color:#0a0f1e; border:1px solid #1e293b;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            <tr>
              <td style="width:40px; vertical-align:middle;">
                <!-- App icon -->
                <div style="width:36px; height:36px; border-radius:8px; background-color:${accent}; line-height:36px; text-align:center; display:block;">
                  <span style="font-size:18px;">&#128640;</span>
                </div>
              </td>
              <td style="padding-left:12px; vertical-align:middle;">
                <p style="margin:0 0 2px; font-size:15px; font-weight:700; color:#ffffff;">${appName}</p>
                <p style="margin:0; font-size:12px; color:#64748b;">${isPasswordProtected ? 'Password-protected app' : 'Public app'} &bull; ${portalName}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    ${passwordBlock}

    <!-- CTA Button -->
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
      <tr>
        <td align="center" style="border-radius:12px;">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" style="height:50px;v-text-anchor:middle;width:220px;" arcsize="24%" fillcolor="${accent}" strokeweight="0">
            <w:anchorlock/>
            <center style="color:#ffffff;font-weight:700;font-size:16px;font-family:Arial,sans-serif;">Open App &#8594;</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-->
          <a href="${shareUrl}" target="_blank"
             style="display:inline-block; padding:15px 40px; font-size:16px; font-weight:700; color:#ffffff; text-decoration:none; border-radius:12px; background-color:${accent}; letter-spacing:-0.2px;">
            Open App &#8594;
          </a>
          <!--<![endif]-->
        </td>
      </tr>
    </table>

    <!-- Direct link fallback -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td style="padding:14px 18px; border-radius:8px; background-color:#0a0f1e; border:1px solid #1e293b;">
          <p style="margin:0 0 4px; font-size:11px; color:#64748b;">Or copy this link into your browser:</p>
          <p style="margin:0; font-size:12px; color:#94a3b8; word-break:break-all; font-family:'Courier New',Courier,monospace;">${shareUrl}</p>
        </td>
      </tr>
    </table>
  `;

  return baseTemplate(
    content,
    `${senderName} shared "${appName}" with you`,
    branding,
  );
}

export function shareLinkText(params: ShareLinkEmailParams, branding?: EmailBranding): string {
  const portalName = branding?.portalName || 'BridgesLLM';
  const { senderName, appName, shareUrl, isPasswordProtected, password } = params;

  const passwordLine = isPasswordProtected && password
    ? `\nPassword: ${password}\n`
    : isPasswordProtected
    ? `\nThis app is password-protected. Ask ${senderName} for the password.\n`
    : '';

  return `${senderName} shared "${appName}" with you via ${portalName}.
${passwordLine}
Open the app here:
${shareUrl}

— ${portalName}`;
}
