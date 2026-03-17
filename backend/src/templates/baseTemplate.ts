/**
 * Base email template with dynamic portal branding
 * 
 * Pulls portal name, logo, and accent color from options.
 * Use `getEmailBranding()` to load these from the database.
 * 
 * Email client compatibility:
 * - NO rgba() — solid hex colors only
 * - NO backdrop-filter or blur
 * - NO CSS custom properties
 * - Tables for layout, inline styles only
 * - background-color (not background shorthand) for Outlook
 * - MSO conditional comments for Outlook-specific fixes
 * 
 * iOS Mail note: iOS Mail strips/ignores body background on many devices.
 * The card-based design ensures readability regardless of outer bg.
 */

import { PrismaClient } from '@prisma/client';
import { APPEARANCE_DEFAULTS } from '../config/settings.schema';

const prisma = new PrismaClient();

export interface EmailBranding {
  portalName: string;
  logoUrl: string;       // full URL to the logo image, or empty for fallback letter
  accentColor: string;   // hex like "#06b6d4"
  siteUrl: string;       // e.g. "https://bridgesllm.com"
}

const DEFAULT_BRANDING: EmailBranding = {
  portalName: APPEARANCE_DEFAULTS.portalName,
  logoUrl: '',
  accentColor: APPEARANCE_DEFAULTS.accentColor,
  siteUrl: process.env.PORTAL_URL || 'https://localhost',
};

/**
 * Load portal branding from the database.
 * Call this once per email send, pass the result to baseTemplate.
 */
export async function getEmailBranding(): Promise<EmailBranding> {
  try {
    const keys = ['appearance.portalName', 'appearance.logoUrl', 'appearance.accentColor'];
    const settings = await prisma.systemSetting.findMany({ where: { key: { in: keys } } });
    const map: Record<string, string> = {};
    for (const s of settings) map[s.key] = s.value;

    const siteUrl = process.env.PORTAL_URL || 'https://localhost';
    const logoPath = map['appearance.logoUrl'] || '';
    // Convert relative logo path to absolute URL
    const logoUrl = logoPath && !logoPath.startsWith('http') ? `${siteUrl}${logoPath}` : logoPath;

    return {
      portalName: map['appearance.portalName'] || DEFAULT_BRANDING.portalName,
      logoUrl,
      accentColor: map['appearance.accentColor'] || DEFAULT_BRANDING.accentColor,
      siteUrl,
    };
  } catch {
    return { ...DEFAULT_BRANDING };
  }
}

/**
 * Derive a darker shade from the accent color for backgrounds.
 * Returns a hex color ~20% brightness of the original.
 */
function darkenAccent(hex: string): string {
  const h = hex.replace('#', '');
  const r = Math.round(parseInt(h.substring(0, 2), 16) * 0.2);
  const g = Math.round(parseInt(h.substring(2, 4), 16) * 0.2);
  const b = Math.round(parseInt(h.substring(4, 6), 16) * 0.2);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Get the first letter of the portal name for the fallback logo.
 */
function getInitial(name: string): string {
  return (name.charAt(0) || 'B').toUpperCase();
}

/**
 * Cache branding for up to 5 minutes so we don't hit the DB on every email.
 */
let _cachedBranding: EmailBranding | null = null;
let _cacheTs = 0;
const CACHE_TTL = 5 * 60 * 1000;

export async function getCachedBranding(): Promise<EmailBranding> {
  if (_cachedBranding && Date.now() - _cacheTs < CACHE_TTL) return _cachedBranding;
  _cachedBranding = await getEmailBranding();
  _cacheTs = Date.now();
  return _cachedBranding;
}

export function baseTemplate(content: string, preheaderText?: string, branding?: EmailBranding): string {
  const b = branding || DEFAULT_BRANDING;
  const accent = b.accentColor || '#6366f1';
  const accentDark = darkenAccent(accent);
  const initial = getInitial(b.portalName);

  // Logo: use custom image if available, otherwise letter in gradient box
  const logoHtml = b.logoUrl
    ? `<img src="${b.logoUrl}" alt="${b.portalName}" width="48" height="48" style="display:block; width:48px; height:48px; border-radius:12px; object-fit:contain;" />`
    : `<!--[if mso]>
                    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" style="width:48px;height:48px;v-text-anchor:middle;" arcsize="25%" fillcolor="${accentDark}" strokecolor="${accent}" strokeweight="1px">
                      <v:textbox inset="0,0,0,0">
                        <center style="color:#ffffff;font-weight:bold;font-size:22px;font-family:Arial,sans-serif;">${initial}</center>
                      </v:textbox>
                    </v:roundrect>
                    <![endif]-->
                    <!--[if !mso]><!--><div style="width:48px;height:48px;border-radius:12px;background-color:${accent};display:block;line-height:48px;text-align:center;">
                      <span style="color:#ffffff; font-weight:bold; font-size:22px; line-height:48px;">${initial}</span>
                    </div><!--<![endif]-->`;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:AllowPNG/>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <title>${b.portalName}</title>
  ${preheaderText ? `<!--[if !mso]><!--><span style="display:none;font-size:0;color:#111827;max-height:0;overflow:hidden;mso-hide:all;">${preheaderText}</span><!--<![endif]-->` : ''}
  <style>
    :root { color-scheme: dark; supported-color-schemes: dark; }
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    body { margin: 0; padding: 0; width: 100% !important; min-width: 100%; background-color: #111827 !important; }
    /* Dark mode support for email clients that honor it */
    [data-ogsc] body, [data-ogsb] body { background-color: #111827 !important; }
    @media (prefers-color-scheme: dark) {
      body { background-color: #111827 !important; }
    }
    @media only screen and (max-width: 620px) {
      .email-container { width: 100% !important; max-width: 100% !important; }
      .email-content { padding: 24px 16px !important; }
      .email-header { padding: 24px 16px !important; }
    }
  </style>
</head>
<body style="margin:0; padding:0; background-color:#111827; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <!-- Full-width background wrapper -->
  <!--[if mso]>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#111827;">
  <tr><td align="center">
  <![endif]-->
  <div style="background-color:#111827; width:100%; margin:0; padding:0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#111827; margin:0; padding:0;" bgcolor="#111827">
    <tr>
      <td align="center" style="padding:0; background-color:#111827;" bgcolor="#111827">

        <!-- Top accent strip -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="height:3px; background-color:${accent};" bgcolor="${accent}">
              <!--[if !mso]><!--><div style="height:3px; background:linear-gradient(90deg, #111827 0%, ${accent} 30%, ${accent} 70%, #111827 100%);"></div><!--<![endif]-->
            </td>
          </tr>
        </table>

        <!-- Spacer -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="height:40px; background-color:#111827;" bgcolor="#111827"></td></tr>
        </table>

        <!-- Email Container (card) -->
        <table role="presentation" class="email-container" width="560" cellpadding="0" cellspacing="0" style="max-width:560px; width:100%; border-radius:16px; overflow:hidden; border:1px solid #1e293b;" bgcolor="#0f172a">
          <!-- Header -->
          <tr>
            <td class="email-header" align="center" style="padding:32px 32px 24px; background-color:#0f172a; border-bottom:1px solid #1e293b;" bgcolor="#0f172a">
              <!-- Portal Logo -->
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="width:48px; height:48px;">
                    ${logoHtml}
                  </td>
                </tr>
              </table>
              <p style="margin:12px 0 0; font-size:20px; font-weight:700; color:#ffffff; letter-spacing:-0.3px;">
                ${b.portalName}
              </p>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td class="email-content" style="padding:32px; background-color:#0f172a;" bgcolor="#0f172a">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td align="center" style="padding:20px 32px; background-color:#0a0f1e; border-top:1px solid #1e293b;" bgcolor="#0a0f1e">
              <p style="margin:0; font-size:11px; color:#64748b; line-height:1.6;">
                ${b.portalName} &bull; Automated notification<br>
                You received this email because of your account activity.
              </p>
            </td>
          </tr>
        </table>

        <!-- Spacer -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="height:40px; background-color:#111827;" bgcolor="#111827"></td></tr>
        </table>

        <!-- Bottom accent strip (symmetry) -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="height:2px; background-color:#111827;" bgcolor="#111827">
              <!--[if !mso]><!--><div style="height:2px; background:linear-gradient(90deg, #111827 0%, ${accent} 30%, ${accent} 70%, #111827 100%); opacity:0.5;"></div><!--<![endif]-->
              <!--[if mso]><div style="height:2px; background-color:${accentDark};"></div><![endif]-->
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
  </div>
  <!--[if mso]>
  </td></tr></table>
  <![endif]-->
</body>
</html>`;
}
