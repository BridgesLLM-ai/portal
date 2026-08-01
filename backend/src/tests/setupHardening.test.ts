import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { isSafeMutableImageAssetPath, normalizeBrandingLogoToPng, UnsafeImageUploadError } from '../services/imageAssets';
import {
  SETUP_STATE_COMPLETE,
  classifySetupTransport,
  classifySetupProgress,
  hashSetupCredential,
  setupBrowserContextMatches,
  validateSetupBootstrapCredential,
  validateSetupLogoUrl,
  validateSetupSessionCredential,
} from '../services/setupHardening';

describe('initial setup hardening', () => {
  test('permits sensitive setup only through verified HTTPS or true loopback HTTP', () => {
    const publicHttp = classifySetupTransport({
      protocol: 'http',
      host: '203.0.113.10',
      requestIp: '198.51.100.20',
      remoteAddress: '127.0.0.1',
    });
    expect(publicHttp).toMatchObject({ allowed: false, kind: 'blocked' });

    const forgedLoopbackHost = classifySetupTransport({
      protocol: 'http',
      host: 'localhost:4001',
      requestIp: '198.51.100.20',
      remoteAddress: '127.0.0.1',
    });
    expect(forgedLoopbackHost).toMatchObject({ allowed: false, kind: 'blocked' });

    const loopback = classifySetupTransport({
      protocol: 'http',
      host: 'localhost:4001',
      requestIp: '::ffff:127.0.0.1',
      remoteAddress: '::1',
    });
    expect(loopback).toEqual({ allowed: true, kind: 'loopback', origin: 'http://localhost:4001' });

    const https = classifySetupTransport({
      protocol: 'https',
      host: 'portal.example.com',
      requestIp: '198.51.100.20',
      remoteAddress: '127.0.0.1',
    });
    expect(https).toEqual({ allowed: true, kind: 'https', origin: 'https://portal.example.com' });
  });

  test('requires same-origin browser context for credential-bearing setup requests', () => {
    const transport = classifySetupTransport({
      protocol: 'https',
      host: 'portal.example.com',
      requestIp: '198.51.100.20',
      remoteAddress: '127.0.0.1',
    });
    expect(setupBrowserContextMatches({
      transport,
      method: 'POST',
      originHeader: 'https://portal.example.com',
      fetchSiteHeader: 'same-origin',
    })).toBe(true);
    expect(setupBrowserContextMatches({
      transport,
      method: 'POST',
      originHeader: 'https://attacker.example',
      fetchSiteHeader: 'cross-site',
    })).toBe(false);
    expect(setupBrowserContextMatches({ transport, method: 'POST' })).toBe(false);
    expect(setupBrowserContextMatches({
      transport,
      method: 'GET',
      fetchSiteHeader: 'same-origin',
    })).toBe(true);
  });

  test('rejects bootstrap replay and expiry without disclosing token values', () => {
    const base = {
      providedToken: 'bootstrap-secret',
      expectedToken: 'bootstrap-secret',
      expiresAt: '2000',
      nowEpochSeconds: 1000,
    };
    expect(validateSetupBootstrapCredential(base)).toEqual({ ok: true, expiresAt: 2000 });
    expect(validateSetupBootstrapCredential({ ...base, usedAt: '1001' })).toEqual({ ok: false, code: 'replayed' });
    expect(validateSetupBootstrapCredential({ ...base, nowEpochSeconds: 2000 })).toEqual({ ok: false, code: 'expired' });
    expect(validateSetupBootstrapCredential({ ...base, providedToken: 'wrong' })).toEqual({ ok: false, code: 'invalid' });
  });

  test('binds setup bearer sessions to their issuing origin and expiry', () => {
    const sessionToken = 'session-secret';
    const base = {
      providedToken: sessionToken,
      expectedTokenHash: hashSetupCredential(sessionToken),
      expectedOrigin: 'https://portal.example.com',
      requestOrigin: 'https://portal.example.com',
      expiresAt: '3000',
      nowEpochSeconds: 2000,
    };
    expect(validateSetupSessionCredential(base)).toEqual({ ok: true, expiresAt: 3000 });
    expect(validateSetupSessionCredential({ ...base, requestOrigin: 'https://evil.example' }))
      .toEqual({ ok: false, code: 'origin' });
    expect(validateSetupSessionCredential({ ...base, nowEpochSeconds: 3000 }))
      .toEqual({ ok: false, code: 'expired' });
    expect(validateSetupSessionCredential({ ...base, providedToken: 'replayed-old-session' }))
      .toEqual({ ok: false, code: 'invalid' });
  });

  test('a committed setup marker prevents a retained token from reopening recovery', () => {
    expect(classifySetupProgress({
      ownerCount: 1,
      setupState: SETUP_STATE_COMPLETE,
      hasSetupToken: true,
    })).toEqual({ needsSetup: false, isReinstall: false, setupComplete: true });

    expect(classifySetupProgress({
      ownerCount: 1,
      setupState: null,
      hasSetupToken: true,
    })).toEqual({ needsSetup: false, isReinstall: true, setupComplete: false });

    expect(classifySetupProgress({
      ownerCount: 0,
      setupState: null,
      hasSetupToken: true,
    })).toEqual({ needsSetup: true, isReinstall: false, setupComplete: false });
  });

  test('normalizes raster uploads to a static PNG and ignores client extension/MIME claims', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-setup-logo-'));
    const outputPath = path.join(dir, 'portal-logo-123e4567-e89b-12d3-a456-426614174000.png');
    try {
      const jpeg = await sharp({
        create: { width: 64, height: 32, channels: 3, background: '#10b981' },
      }).jpeg().toBuffer();
      await normalizeBrandingLogoToPng(jpeg, outputPath);

      const metadata = await sharp(outputPath).metadata();
      expect(metadata.format).toBe('png');
      expect(validateSetupLogoUrl('/static-assets/branding/portal-logo-123e4567-e89b-12d3-a456-426614174000.png', dir))
        .toBe('/static-assets/branding/portal-logo-123e4567-e89b-12d3-a456-426614174000.png');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects SVG content even when a client labels it as a raster upload', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-setup-svg-'));
    const outputPath = path.join(dir, 'portal-logo-123e4567-e89b-12d3-a456-426614174001.png');
    try {
      const activeSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>');
      await expect(normalizeBrandingLogoToPng(activeSvg, outputPath)).rejects.toBeInstanceOf(UnsafeImageUploadError);
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the mutable same-origin asset surface serves only raster/video extensions', () => {
    expect(isSafeMutableImageAssetPath('/branding/portal-logo-1.png')).toBe(true);
    expect(isSafeMutableImageAssetPath('/avatars/operator.webm')).toBe(true);
    expect(isSafeMutableImageAssetPath('/branding/payload.svg')).toBe(false);
    expect(isSafeMutableImageAssetPath('/branding/payload.html')).toBe(false);
    expect(isSafeMutableImageAssetPath('/branding/../payload.png')).toBe(false);
    expect(isSafeMutableImageAssetPath('/branding/nested/payload.png')).toBe(false);
  });

  test('accepts only an existing, non-symlinked Portal PNG URL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-setup-path-'));
    const filename = 'portal-logo-123e4567-e89b-12d3-a456-426614174002.png';
    const target = path.join(dir, filename);
    try {
      await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ffffff' } }).png().toFile(target);
      expect(() => validateSetupLogoUrl('https://attacker.invalid/logo.svg', dir)).toThrow(/normalized PNG/i);
      expect(() => validateSetupLogoUrl('/static-assets/branding/../../logo.png', dir)).toThrow(/normalized PNG/i);

      const symlinkName = 'portal-logo-123e4567-e89b-12d3-a456-426614174003.png';
      fs.symlinkSync(target, path.join(dir, symlinkName));
      expect(() => validateSetupLogoUrl(`/static-assets/branding/${symlinkName}`, dir)).toThrow(/not found/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps owner, settings, initial session, and completion marker in one locked transaction', () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/setup-v3.ts'), 'utf8');
    const legacySource = fs.readFileSync(path.resolve(__dirname, '../routes/setup-legacy.ts'), 'utf8');
    expect(routeSource).toContain('prisma.$transaction(async (tx) =>');
    expect(routeSource).toContain('pg_advisory_xact_lock');
    expect(routeSource).toContain("isolationLevel: 'Serializable'");
    expect(
      routeSource.match(/await assertNoProjectAuthorizationTransitionActive\(tx\)/g),
    ).toHaveLength(2);
    expect(routeSource).toContain('authorizationVersion: { increment: 1 }');
    expect(routeSource).toContain("reasons: ['credential_recovery']");
    expect(routeSource).toContain('await tx.user.create');
    expect(routeSource).toContain('await tx.session.create');
    expect(routeSource).toContain('await tx.systemSetting.upsert');
    expect(routeSource).toContain('SETUP_STATE_COMPLETE');
    expect(routeSource).toContain("router.post(\n  '/tailnet-onboarding'");
    expect(routeSource).toContain('[OLLAMA_TAILNET_ONBOARDING_KEY]: body.tailnetRequested');
    expect(routeSource).toContain('tailnetOnboarding: {');
    expect(routeSource).toContain("router.post('/bootstrap'");
    expect(routeSource).toContain("router.post('/bootstrap/handoff'");
    expect(routeSource).not.toContain('req.query.token');
    expect(routeSource).not.toContain("req.headers['x-setup-token']");
    expect(routeSource).not.toContain('const user = await prisma.user.create');
    expect(routeSource).not.toContain("'image/svg+xml'");
    expect(legacySource).toContain("from './setup-v3'");
    expect(legacySource).not.toContain('multer.diskStorage');
  });
});
