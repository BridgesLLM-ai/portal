export const DEFAULT_PORTAL_LOGO_URL = '/logo-display.png';
const VENDOR_PORTAL_BRANDING_PATHS = ['/landing', '/docs'] as const;

type PortalIconDefinition = {
  selector: string;
  rel: 'icon' | 'apple-touch-icon';
  type?: string;
  sizes?: string;
  defaultHref: string;
};

const PORTAL_ICON_DEFINITIONS: PortalIconDefinition[] = [
  {
    selector: "link[data-portal-icon='favicon']",
    rel: 'icon',
    type: 'image/x-icon',
    defaultHref: '/favicon.ico',
  },
  {
    selector: "link[data-portal-icon='favicon-192']",
    rel: 'icon',
    type: 'image/png',
    sizes: '192x192',
    defaultHref: '/favicon-192.png',
  },
  {
    selector: "link[data-portal-icon='apple-touch']",
    rel: 'apple-touch-icon',
    sizes: '512x512',
    defaultHref: '/favicon-512.png',
  },
];

export function resolvePortalLogoUrl(logoUrl?: string | null): string {
  return logoUrl?.trim() || DEFAULT_PORTAL_LOGO_URL;
}

export function isVendorPortalBrandingPath(pathname?: string | null): boolean {
  const normalized = (pathname?.trim() || '/')
    .split(/[?#]/, 1)[0]
    .replace(/\/+$/, '')
    .toLowerCase() || '/';
  return VENDOR_PORTAL_BRANDING_PATHS.some((prefix) => (
    normalized === prefix || normalized.startsWith(`${prefix}/`)
  ));
}

function ensurePortalIconLink(
  definition: PortalIconDefinition,
  documentRef: Document,
): HTMLLinkElement {
  let link = documentRef.querySelector<HTMLLinkElement>(definition.selector);
  if (link) return link;

  link = documentRef.createElement('link');
  link.rel = definition.rel;
  if (definition.type) link.setAttribute('type', definition.type);
  if (definition.sizes) link.setAttribute('sizes', definition.sizes);
  const iconId = definition.selector.match(/data-portal-icon='([^']+)'/)?.[1];
  if (iconId) link.dataset.portalIcon = iconId;
  documentRef.head.appendChild(link);
  return link;
}

export function synchronizePortalIconLinks(
  logoUrl?: string | null,
  documentRef: Document = document,
): void {
  const customLogoUrl = logoUrl?.trim() || '';

  for (const definition of PORTAL_ICON_DEFINITIONS) {
    const link = ensurePortalIconLink(definition, documentRef);
    link.rel = definition.rel;
    link.href = customLogoUrl || definition.defaultHref;
    if (customLogoUrl) {
      // Custom uploads may be GIF, PNG, WebP, or another browser-supported
      // image. Stale bundled type/size hints can make browsers reject them.
      link.removeAttribute('type');
      link.removeAttribute('sizes');
    } else {
      if (definition.type) link.setAttribute('type', definition.type);
      else link.removeAttribute('type');
      if (definition.sizes) link.setAttribute('sizes', definition.sizes);
      else link.removeAttribute('sizes');
    }
  }
}
