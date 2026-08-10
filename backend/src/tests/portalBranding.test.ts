import fs from 'fs';
import path from 'path';
import {
  DEFAULT_PORTAL_LOGO_PATH,
  absolutePortalBrandingAssetUrl,
  injectConfiguredPortalIconLinks,
  isVendorBrandingSurface,
  normalizePortalBrandingAssetUrl,
  resolvePortalBrandingLogoPath,
} from '../services/portalBranding';

describe('server-rendered Portal branding', () => {
  test('gives the explicit appearance logo Open Graph precedence over detected and legacy images', () => {
    expect(resolvePortalBrandingLogoPath({
      appearanceLogoUrl: '/static-assets/branding/tenant.gif',
      detectedLogoPath: '/static-assets/branding/detected.png',
      legacyLogoUrl: 'https://legacy.example.test/logo.png',
    })).toBe('/static-assets/branding/tenant.gif');

    expect(resolvePortalBrandingLogoPath({
      appearanceLogoUrl: 'javascript:alert(1)',
      detectedLogoPath: '/static-assets/branding/detected.png',
      legacyLogoUrl: 'https://legacy.example.test/logo.png',
    })).toBe(DEFAULT_PORTAL_LOGO_PATH);

    expect(resolvePortalBrandingLogoPath({
      appearanceLogoUrl: '',
      detectedLogoPath: '/static-assets/branding/stale-upload.png',
      legacyLogoUrl: 'https://legacy.example.test/logo.png',
    })).toBe(DEFAULT_PORTAL_LOGO_PATH);

    expect(resolvePortalBrandingLogoPath({
      detectedLogoPath: '/static-assets/branding/detected.png',
      legacyLogoUrl: 'https://legacy.example.test/logo.png',
    })).toBe('/static-assets/branding/detected.png');

    expect(resolvePortalBrandingLogoPath({})).toBe(DEFAULT_PORTAL_LOGO_PATH);
  });

  test('normalizes only safe same-origin paths and credential-free HTTP(S) URLs', () => {
    expect(normalizePortalBrandingAssetUrl('/static-assets/branding/logo.png?rev=2'))
      .toBe('/static-assets/branding/logo.png?rev=2');
    expect(normalizePortalBrandingAssetUrl('https://cdn.example.test/logo.svg'))
      .toBe('https://cdn.example.test/logo.svg');
    expect(normalizePortalBrandingAssetUrl('//cdn.example.test/logo.png')).toBe('');
    expect(normalizePortalBrandingAssetUrl('https://user:pass@cdn.example.test/logo.png')).toBe('');
    expect(normalizePortalBrandingAssetUrl('data:image/png;base64,AAAA')).toBe('');
    expect(normalizePortalBrandingAssetUrl('/static\\assets/logo.png')).toBe('');

    expect(absolutePortalBrandingAssetUrl(
      'https://portal.example.test',
      '/static-assets/branding/logo.png',
    )).toBe('https://portal.example.test/static-assets/branding/logo.png');
    expect(absolutePortalBrandingAssetUrl('not an origin', '/logo-display.png')).toBe('');
  });

  test('replaces every default icon candidate before paint without stale MIME or size hints', () => {
    const source = `<!doctype html><html><head>
      <meta charset="UTF-8" />
      <link rel="icon" type="image/x-icon" href="/favicon.ico" />
      <link sizes="192x192" href="/favicon-192.png" rel="icon" type="image/png" />
      <link rel="apple-touch-icon" sizes="512x512" href="/favicon-512.png" />
      <link rel="stylesheet" href="/assets/app.css" />
    </head><body></body></html>`;

    const rendered = injectConfiguredPortalIconLinks(
      source,
      'https://cdn.example.test/tenant.gif?theme=a&size=2',
    );

    expect(rendered).not.toContain('/favicon.ico');
    expect(rendered).not.toContain('/favicon-192.png');
    expect(rendered).not.toContain('/favicon-512.png');
    expect(rendered.match(/data-portal-icon="favicon"/g)).toHaveLength(1);
    expect(rendered.match(/data-portal-icon="favicon-192"/g)).toHaveLength(1);
    expect(rendered.match(/data-portal-icon="apple-touch"/g)).toHaveLength(1);
    expect(rendered.match(/data-portal-icon=/g)).toHaveLength(3);
    const customIconLinks = rendered.match(/<link\b[^>]*data-portal-icon="[^"]+"[^>]*>/g) || [];
    expect(customIconLinks).toHaveLength(3);
    for (const link of customIconLinks) {
      expect(link).not.toMatch(/\btype=/);
      expect(link).not.toMatch(/\bsizes=/);
    }
    expect(rendered).toContain('href="https://cdn.example.test/tenant.gif?theme=a&amp;size=2"');
    expect(rendered).toContain('<link rel="stylesheet" href="/assets/app.css" />');
    expect(rendered.indexOf('data-portal-icon="favicon"'))
      .toBeLessThan(rendered.indexOf('<meta charset="UTF-8"'));
  });

  test('preserves bundled icon links when no valid custom logo is configured', () => {
    const source = '<html><head><link rel="icon" type="image/png" href="/favicon.png" /></head></html>';
    expect(injectConfiguredPortalIconLinks(source, '')).toBe(source);
    expect(injectConfiguredPortalIconLinks(source, 'javascript:alert(1)')).toBe(source);
  });

  test('keeps tenant branding off vendor landing and documentation paths', () => {
    expect(isVendorBrandingSurface('/landing')).toBe(true);
    expect(isVendorBrandingSurface('/landing/')).toBe(true);
    expect(isVendorBrandingSurface('/Landing')).toBe(true);
    expect(isVendorBrandingSurface('/docs/getting-started')).toBe(true);
    expect(isVendorBrandingSurface('/Docs/Getting-Started')).toBe(true);
    expect(isVendorBrandingSurface('/login')).toBe(false);
    expect(isVendorBrandingSurface('/dashboard')).toBe(false);

    const serverSource = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
    expect(serverSource).toContain('isVendorBrandingSurface(req.path)');
    expect(serverSource).toContain('injectConfiguredPortalIconLinks(sourceHtml, appearanceLogoUrl)');
    expect(serverSource).toContain('resolvePortalBrandingLogoPath({');
    expect(serverSource).toContain('createSpaStaticAssetMiddleware(frontendDist)');
    expect(serverSource).toContain(
      "settings.get('appearance.portalName') || settings.get('system.siteName')",
    );
  });
});
