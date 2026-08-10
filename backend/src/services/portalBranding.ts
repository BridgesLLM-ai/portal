export const DEFAULT_PORTAL_LOGO_PATH = '/logo-display.png';
export const DEFAULT_PORTAL_ACCENT_COLOR = '#6366f1';

const VENDOR_BRANDING_PATHS = ['/landing', '/docs'] as const;

function trimmed(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizePortalAccentColor(
  value: string | null | undefined,
  fallback = DEFAULT_PORTAL_ACCENT_COLOR,
): string {
  const candidate = trimmed(value);
  return /^#[0-9a-fA-F]{6}$/.test(candidate) ? candidate.toLowerCase() : fallback;
}

/**
 * Accept only the same URL forms allowed by the appearance settings API:
 * a root-relative same-origin path or an absolute HTTP(S) URL without
 * credentials. Database rows can predate that API validation, so every HTML
 * consumer still validates at the final rendering boundary.
 */
export function normalizePortalBrandingAssetUrl(value: string | null | undefined): string {
  const candidate = trimmed(value);
  if (!candidate || /[\\\u0000-\u001f\u007f]/.test(candidate)) return '';

  if (candidate.startsWith('/')) {
    if (candidate.startsWith('//')) return '';
    try {
      const base = new URL('https://portal.invalid');
      const parsed = new URL(candidate, base);
      if (parsed.origin !== base.origin) return '';
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return '';
    }
  }

  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

export function absolutePortalBrandingAssetUrl(
  requestOrigin: string,
  assetUrl: string | null | undefined,
): string {
  const normalized = normalizePortalBrandingAssetUrl(assetUrl);
  if (!normalized) return '';
  if (!normalized.startsWith('/')) return normalized;

  try {
    const origin = new URL(requestOrigin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) return '';
    return new URL(normalized, origin).toString();
  } catch {
    return '';
  }
}

export function resolvePortalBrandingLogoPath(input: {
  appearanceLogoUrl?: string | null;
  detectedLogoPath?: string | null;
  legacyLogoUrl?: string | null;
  defaultLogoPath?: string | null;
}): string {
  const defaultLogoPath = input.defaultLogoPath === undefined
    ? DEFAULT_PORTAL_LOGO_PATH
    : input.defaultLogoPath;
  const hasAppearanceSetting = input.appearanceLogoUrl !== undefined
    && input.appearanceLogoUrl !== null;
  const candidates = hasAppearanceSetting
    ? [input.appearanceLogoUrl, defaultLogoPath]
    : [input.detectedLogoPath, input.legacyLogoUrl, defaultLogoPath];
  for (const candidate of candidates) {
    const normalized = normalizePortalBrandingAssetUrl(candidate);
    if (normalized) return normalized;
  }
  return '';
}

export function isVendorBrandingSurface(pathname: string | null | undefined): boolean {
  const normalized = trimmed(pathname)
    .split(/[?#]/, 1)[0]
    .replace(/\/+$/, '')
    .toLowerCase() || '/';
  return VENDOR_BRANDING_PATHS.some((prefix) => (
    normalized === prefix || normalized.startsWith(`${prefix}/`)
  ));
}

function htmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function linkRelTokens(tag: string): string[] {
  const match = tag.match(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const value = match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
  return value.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Replace, rather than append to, every static icon candidate when a tenant
 * logo is configured. This prevents the HTML parser from fetching or briefly
 * selecting a bundled default before React starts, and it avoids lying about
 * a custom GIF/WebP/SVG with the default PNG/ICO type and size attributes.
 */
export function injectConfiguredPortalIconLinks(
  sourceHtml: string,
  appearanceLogoUrl: string | null | undefined,
): string {
  const customIconUrl = normalizePortalBrandingAssetUrl(appearanceLogoUrl);
  if (!customIconUrl || !/<head(?:\s[^>]*)?>/i.test(sourceHtml)) return sourceHtml;

  const withoutDefaultIcons = sourceHtml.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = linkRelTokens(tag);
    return rel.includes('icon') || rel.includes('apple-touch-icon') ? '' : tag;
  });
  const safeUrl = htmlAttribute(customIconUrl);
  const iconMarkup = [
    `<link rel="icon" href="${safeUrl}" data-portal-icon="favicon" />`,
    `<link rel="icon" href="${safeUrl}" data-portal-icon="favicon-192" />`,
    `<link rel="apple-touch-icon" href="${safeUrl}" data-portal-icon="apple-touch" />`,
  ].join('\n    ');

  return withoutDefaultIcons.replace(
    /<head(?:\s[^>]*)?>/i,
    (head) => `${head}\n    ${iconMarkup}`,
  );
}
