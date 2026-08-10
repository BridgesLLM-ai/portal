const findMany = jest.fn();

jest.mock('../config/database', () => ({
  prisma: { systemSetting: { findMany } },
}));

import {
  baseTemplate,
  getCachedBranding,
  getEmailBranding,
  invalidateEmailBrandingCache,
} from '../templates/baseTemplate';

describe('email branding cache', () => {
  const originalPortalUrl = process.env.PORTAL_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    invalidateEmailBrandingCache();
    process.env.PORTAL_URL = 'https://portal.example.test';
    findMany.mockResolvedValue([]);
  });

  afterAll(() => {
    if (originalPortalUrl === undefined) delete process.env.PORTAL_URL;
    else process.env.PORTAL_URL = originalPortalUrl;
  });

  test('uses the bundled display logo as an absolute email default while leaving the stored custom setting empty', async () => {
    await expect(getEmailBranding()).resolves.toEqual({
      portalName: 'Bridges Portal',
      logoUrl: 'https://portal.example.test/logo-display.png',
      accentColor: '#6366f1',
      siteUrl: 'https://portal.example.test',
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        key: {
          in: ['appearance.portalName', 'appearance.logoUrl', 'appearance.accentColor'],
        },
      },
    });
    expect(baseTemplate('<p>Body</p>')).toContain('src="https://portal.example.test/logo-display.png"');
  });

  test('makes a configured relative logo absolute and falls safely back from an invalid legacy row', async () => {
    findMany.mockResolvedValueOnce([
      { key: 'appearance.portalName', value: 'Tenant Portal' },
      { key: 'appearance.logoUrl', value: '/static-assets/branding/tenant.gif' },
      { key: 'appearance.accentColor', value: '#123456' },
    ]);
    await expect(getEmailBranding()).resolves.toEqual({
      portalName: 'Tenant Portal',
      logoUrl: 'https://portal.example.test/static-assets/branding/tenant.gif',
      accentColor: '#123456',
      siteUrl: 'https://portal.example.test',
    });

    findMany.mockResolvedValueOnce([
      { key: 'appearance.logoUrl', value: 'javascript:alert(1)' },
    ]);
    await expect(getEmailBranding()).resolves.toMatchObject({
      logoUrl: 'https://portal.example.test/logo-display.png',
    });
  });

  test('invalidates a warm cache immediately after a committed branding mutation', async () => {
    findMany.mockResolvedValueOnce([{ key: 'appearance.portalName', value: 'Before' }]);
    await expect(getCachedBranding()).resolves.toMatchObject({ portalName: 'Before' });

    findMany.mockResolvedValueOnce([{ key: 'appearance.portalName', value: 'After' }]);
    await expect(getCachedBranding()).resolves.toMatchObject({ portalName: 'Before' });
    expect(findMany).toHaveBeenCalledTimes(1);

    invalidateEmailBrandingCache();
    await expect(getCachedBranding()).resolves.toMatchObject({ portalName: 'After' });
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  test('does not let an in-flight pre-invalidation read poison the next cache generation', async () => {
    let releaseStaleRead!: (rows: Array<{ key: string; value: string }>) => void;
    findMany.mockImplementationOnce(() => new Promise((resolve) => { releaseStaleRead = resolve; }));
    const staleRead = getCachedBranding();
    invalidateEmailBrandingCache();
    releaseStaleRead([{ key: 'appearance.portalName', value: 'Stale' }]);
    await expect(staleRead).resolves.toMatchObject({ portalName: 'Stale' });

    findMany.mockResolvedValueOnce([{ key: 'appearance.portalName', value: 'Fresh' }]);
    await expect(getCachedBranding()).resolves.toMatchObject({ portalName: 'Fresh' });
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  test('escapes notification HTML branding and rejects unsafe image/CSS values at render time', () => {
    const html = baseTemplate(
      '<p>Trusted template body</p>',
      'Preview <unsafe> & text',
      {
        portalName: 'Tenant <Portal> & "Mail"',
        logoUrl: 'javascript:alert(1)',
        accentColor: 'red; background:url(javascript:alert(1))',
        siteUrl: 'https://portal.example.test',
      },
    );

    expect(html).toContain('<title>Tenant &lt;Portal&gt; &amp; &quot;Mail&quot;</title>');
    expect(html).toContain('Preview &lt;unsafe&gt; &amp; text');
    expect(html).toContain('<p>Trusted template body</p>');
    expect(html).not.toContain('javascript:alert(1)');
    expect(html).not.toContain('background:url');
    expect(html).toContain('background-color:#6366f1');
  });
});
