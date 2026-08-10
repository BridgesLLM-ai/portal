// @vitest-environment jsdom
import '../test/setup';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PORTAL_LOGO_URL,
  isVendorPortalBrandingPath,
  resolvePortalLogoUrl,
  synchronizePortalIconLinks,
} from './portalBranding';

describe('portal branding', () => {
  beforeEach(() => {
    document.head.innerHTML = `
      <link rel="icon" type="image/x-icon" href="/favicon.ico" data-portal-icon="favicon">
      <link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png" data-portal-icon="favicon-192">
      <link rel="apple-touch-icon" sizes="512x512" href="/favicon-512.png" data-portal-icon="apple-touch">
    `;
  });

  it('resolves an explicit custom mark or the bundled high-resolution display mark', () => {
    expect(resolvePortalLogoUrl(' /static-assets/branding/customer.png '))
      .toBe('/static-assets/branding/customer.png');
    expect(resolvePortalLogoUrl('')).toBe(DEFAULT_PORTAL_LOGO_URL);
    expect(resolvePortalLogoUrl(undefined)).toBe('/logo-display.png');
  });

  it('keeps vendor landing and documentation routes on bundled branding', () => {
    expect(isVendorPortalBrandingPath('/landing')).toBe(true);
    expect(isVendorPortalBrandingPath('/landing/')).toBe(true);
    expect(isVendorPortalBrandingPath('/Landing')).toBe(true);
    expect(isVendorPortalBrandingPath('/docs/getting-started')).toBe(true);
    expect(isVendorPortalBrandingPath('/Docs/Getting-Started')).toBe(true);
    expect(isVendorPortalBrandingPath('/login')).toBe(false);
    expect(isVendorPortalBrandingPath('/dashboard')).toBe(false);
  });

  it('replaces every icon candidate without stale format hints and restores bundled defaults', () => {
    synchronizePortalIconLinks('/static-assets/branding/animated-logo.gif');

    const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[data-portal-icon]'));
    expect(links).toHaveLength(3);
    for (const link of links) {
      expect(link.getAttribute('href')).toBe('/static-assets/branding/animated-logo.gif');
      expect(link).not.toHaveAttribute('type');
      expect(link).not.toHaveAttribute('sizes');
    }

    synchronizePortalIconLinks('');

    const favicon = document.querySelector<HTMLLinkElement>("link[data-portal-icon='favicon']");
    const favicon192 = document.querySelector<HTMLLinkElement>("link[data-portal-icon='favicon-192']");
    const appleTouch = document.querySelector<HTMLLinkElement>("link[data-portal-icon='apple-touch']");
    expect(favicon).toHaveAttribute('href', '/favicon.ico');
    expect(favicon).toHaveAttribute('type', 'image/x-icon');
    expect(favicon).not.toHaveAttribute('sizes');
    expect(favicon192).toHaveAttribute('href', '/favicon-192.png');
    expect(favicon192).toHaveAttribute('type', 'image/png');
    expect(favicon192).toHaveAttribute('sizes', '192x192');
    expect(appleTouch).toHaveAttribute('href', '/favicon-512.png');
    expect(appleTouch).not.toHaveAttribute('type');
    expect(appleTouch).toHaveAttribute('sizes', '512x512');
  });
});
