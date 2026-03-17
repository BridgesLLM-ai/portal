/**
 * Welcome email template for new users
 */
import { baseTemplate, type EmailBranding } from './baseTemplate';

export function welcomeHtml(username: string, branding?: EmailBranding): string {
  const name = branding?.portalName || 'BridgesLLM';
  const accent = branding?.accentColor || '#10b981';
  const siteUrl = branding?.siteUrl || 'https://localhost';

  const content = `
    <h2 style="margin:0 0 16px; font-size:22px; font-weight:700; color:#ffffff;">Welcome to ${name}! &#127881;</h2>
    <p style="margin:0 0 20px; font-size:15px; color:#94a3b8; line-height:1.6;">
      Hi <strong style="color:#e2e8f0;">${username}</strong>, your account has been created and you're ready to go.
    </p>
    <p style="margin:0 0 24px; font-size:15px; color:#94a3b8; line-height:1.6;">
      Here's what you can do in the portal:
    </p>
    <!-- Feature cards -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 8px;">
      <tr>
        <td style="padding:12px 16px; border-radius:8px; background-color:#0a0f1e; border:1px solid #1e293b;">
          <p style="margin:0 0 4px; font-size:14px; color:#e2e8f0; font-weight:600;">&#128172; Agent Chats</p>
          <p style="margin:0; font-size:13px; color:#94a3b8;">Interact with AI agents for coding, analysis, and more.</p>
        </td>
      </tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 8px;">
      <tr>
        <td style="padding:12px 16px; border-radius:8px; background-color:#0a0f1e; border:1px solid #1e293b;">
          <p style="margin:0 0 4px; font-size:14px; color:#e2e8f0; font-weight:600;">&#128193; File Manager</p>
          <p style="margin:0; font-size:13px; color:#94a3b8;">Upload, manage, and share files from your workspace.</p>
        </td>
      </tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px;">
      <tr>
        <td style="padding:12px 16px; border-radius:8px; background-color:#0a0f1e; border:1px solid #1e293b;">
          <p style="margin:0 0 4px; font-size:14px; color:#e2e8f0; font-weight:600;">&#128640; Apps</p>
          <p style="margin:0; font-size:13px; color:#94a3b8;">Deploy and manage web applications.</p>
        </td>
      </tr>
    </table>
    <!-- Button -->
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
      <tr>
        <td align="center" style="border-radius:12px;">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" style="height:48px;v-text-anchor:middle;width:200px;" arcsize="25%" fillcolor="${accent}" strokeweight="0">
            <w:anchorlock/>
            <center style="color:#ffffff;font-weight:600;font-size:15px;font-family:Arial,sans-serif;">Go to Dashboard</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-->
          <a href="${siteUrl}/dashboard" target="_blank" style="display:inline-block; padding:14px 36px; font-size:15px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:12px; background-color:${accent};">
            Go to Dashboard
          </a>
          <!--<![endif]-->
        </td>
      </tr>
    </table>
  `;

  return baseTemplate(content, `Welcome to ${name}!`, branding);
}

export function welcomeText(username: string, branding?: EmailBranding): string {
  const name = branding?.portalName || 'BridgesLLM';
  const siteUrl = branding?.siteUrl || 'https://localhost';
  return `Welcome to ${name}!

Hi ${username}, your account has been created and you're ready to go.

Here's what you can do in the portal:
- Agent Chats: Interact with AI agents for coding, analysis, and more.
- File Manager: Upload, manage, and share files from your workspace.
- Apps: Deploy and manage web applications.

Visit your dashboard: ${siteUrl}/dashboard

— ${name}`;
}
