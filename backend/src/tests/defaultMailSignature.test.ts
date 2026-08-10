import fs from 'fs';
import path from 'path';

const getCachedBranding = jest.fn();

jest.mock('../templates/baseTemplate', () => ({ getCachedBranding }));

import { buildDefaultMailSignature } from '../services/defaultMailSignature';

describe('first-time mailbox signature branding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getCachedBranding.mockResolvedValue({
      portalName: 'Tenant & Portal',
      logoUrl: 'https://portal.example.test/logo-display.png?rev=1&size=2',
      accentColor: '#6366f1',
      siteUrl: 'https://portal.example.test',
    });
  });

  test('uses the shared appearance branding helper and escapes its HTML output', async () => {
    const result = await buildDefaultMailSignature('Alice <Owner>', 'alice@example.test');

    expect(getCachedBranding).toHaveBeenCalledTimes(1);
    expect(result.signature).toBe('Alice <Owner>\nalice@example.test\nTenant & Portal');
    expect(result.signatureHtml).toContain('Alice &lt;Owner&gt;');
    expect(result.signatureHtml).toContain('Tenant &amp; Portal');
    expect(result.signatureHtml).toContain('src="https://portal.example.test/logo-display.png?rev=1&amp;size=2"');
    expect(result.signatureHtml).not.toContain('Alice <Owner>');
  });

  test('wires the mail route to the helper without obsolete unnamespaced settings keys', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/mail.ts'), 'utf8');
    expect(routeSource).toContain('buildDefaultMailSignature(displayName, email)');
    expect(routeSource).not.toContain("where: { key: 'portalName' }");
    expect(routeSource).not.toContain("where: { key: 'logoUrl' }");
  });
});
