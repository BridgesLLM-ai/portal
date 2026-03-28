/**
 * Two-Factor Verification Code email template
 * 
 * iOS/iPadOS AUTO-FILL REQUIREMENTS (iOS 17+):
 * 1. Email must be received in Apple's native Mail app
 * 2. User must be in Safari (or WebView) with autocomplete="one-time-code" on the input
 * 3. The code must be clearly detectable in both HTML and plain text
 * 4. Apple's parser looks for patterns like:
 *    - "Your verification code is 123456"
 *    - "Code: 123456"  
 *    - "123456 is your verification code"
 * 5. The code should appear as a single contiguous string (NOT split across HTML elements)
 * 6. Sender domain should match the website domain
 * 
 * CRITICAL: The code MUST appear as a single text node in the HTML, not split
 * into individual <td> cells per digit. Apple's parser reads the text content,
 * and "1" "2" "3" "4" "5" "6" in separate elements ≠ "123456".
 */
import { baseTemplate, type EmailBranding } from './baseTemplate';

export function twoFactorCodeHtml(code: string, branding?: EmailBranding): string {
  const name = branding?.portalName || 'BridgesLLM';

  const content = `
    <h2 style="margin:0 0 8px; font-size:22px; font-weight:700; color:#ffffff; text-align:center;">Your verification code</h2>
    <p style="margin:0 0 28px; font-size:14px; color:#94a3b8; line-height:1.6; text-align:center;">
      Use this code to complete your sign-in to ${name}.
    </p>
    <!-- Verification code display — SINGLE text node for iOS auto-fill detection -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 8px;">
      <tr>
        <td align="center" style="padding:28px 0; background-color:#0a0f1e; border:1px solid #1e293b; border-radius:12px;">
          <p style="margin:0; font-family:'Courier New',Courier,monospace; font-size:36px; font-weight:700; color:#ffffff; letter-spacing:12px; text-align:center;">${code}</p>
        </td>
      </tr>
    </table>
    <!-- Repeat code as parseable text for iOS detection -->
    <p style="margin:0 0 24px; font-size:14px; color:#94a3b8; line-height:1.6; text-align:center;">
      Your verification code is <strong style="color:#ffffff;">${code}</strong>
    </p>
    <!-- Expiry notice -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px;">
      <tr>
        <td align="center">
          <p style="margin:0; font-size:13px; color:#94a3b8; line-height:1.5;">
            This code expires in <strong style="color:#e2e8f0;">10 minutes</strong>.
          </p>
        </td>
      </tr>
    </table>
    <!-- Security notice -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td style="border-top:1px solid #1e293b; padding-top:20px;">
          <p style="margin:0; font-size:13px; color:#94a3b8; line-height:1.5;">
            If you didn't request this code, someone may be trying to access your account. You can safely ignore this email.
          </p>
        </td>
      </tr>
    </table>
    <!-- Lost access notice -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:16px;">
      <tr>
        <td style="padding:16px; background-color:#0a0f1e; border:1px solid #1e293b; border-radius:8px;">
          <p style="margin:0; font-size:12px; color:#64748b; line-height:1.5;">
            <strong style="color:#94a3b8;">Lost your backup codes?</strong> Contact your agent directly through Discord or Slack and request an account unlock. Your agent can verify your identity and disable 2FA for you.
          </p>
        </td>
      </tr>
    </table>
  `;

  return baseTemplate(content, `Your verification code is ${code}`, branding);
}

export function twoFactorCodeText(code: string, branding?: EmailBranding): string {
  const name = branding?.portalName || 'BridgesLLM';
  // Plain text format optimized for iOS auto-fill detection.
  // The code must appear on its own line after a clear label.
  // Apple's NLP parser looks for: "Your verification code is NNNNNN"
  return `Your ${name} verification code is ${code}

This code expires in 10 minutes.

If you didn't request this code, someone may be trying to access your account. You can safely ignore this email.

Lost your backup codes? Contact your agent directly through Discord or Slack and request an account unlock. Your agent can verify your identity and disable 2FA for you.

— ${name}`;
}
