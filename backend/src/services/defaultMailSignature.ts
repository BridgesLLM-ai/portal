import { getCachedBranding } from '../templates/baseTemplate';

export interface DefaultMailSignature {
  signature: string;
  signatureHtml: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function buildDefaultMailSignature(
  displayName: string,
  email: string,
): Promise<DefaultMailSignature> {
  const { portalName, logoUrl } = await getCachedBranding();
  const safeName = escapeHtml(displayName);
  const safeEmail = escapeHtml(email);
  const safePortalName = escapeHtml(portalName);
  const safeLogoUrl = escapeHtml(logoUrl);
  const logoTag = safeLogoUrl
    ? `<img src="${safeLogoUrl}" alt="${safePortalName}" style="height:40px;width:auto;margin-bottom:8px;" /><br/>`
    : '';

  return {
    signature: `${displayName}\n${email}\n${portalName}`,
    signatureHtml: `<table cellpadding="0" cellspacing="0" border="0" style="font-family:system-ui,-apple-system,sans-serif;font-size:13px;color:#374151;line-height:1.5;">
  <tr>
    <td style="padding-right:16px;border-right:2px solid #8b5cf6;vertical-align:top;">
      ${logoTag}
    </td>
    <td style="padding-left:16px;vertical-align:top;">
      <div style="font-size:15px;font-weight:600;color:#111827;">${safeName}</div>
      <div style="color:#6b7280;font-size:12px;margin-top:2px;">${safePortalName}</div>
      <div style="margin-top:6px;">
        <a href="mailto:${safeEmail}" style="color:#8b5cf6;text-decoration:none;font-size:12px;">${safeEmail}</a>
      </div>
    </td>
  </tr>
</table>`,
  };
}
