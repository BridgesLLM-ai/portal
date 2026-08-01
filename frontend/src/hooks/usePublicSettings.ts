import { useEffect, useState } from 'react';

export type PortalOriginMode = 'domain' | 'local' | 'tailnet';

export interface PortalFeatureAvailability {
  available: boolean;
  reason: string | null;
}

export interface PublicSettings {
  portalName?: string;
  assistantName?: string;
  logoUrl?: string;
  theme?: 'dark' | 'light' | 'system';
  accentColor?: string;
  useDirectGateway?: boolean;
  registrationMode?: 'open' | 'approval' | 'closed';
  agentAvatars?: Record<string, string>;
  originMode?: PortalOriginMode;
  experimental?: boolean;
  privateNetworkOnly?: boolean;
  mail?: PortalFeatureAvailability;
  appHosting?: PortalFeatureAvailability;
}

const CACHE_KEY = 'cached_publicSettings';

let cachedSettings: PublicSettings | null | undefined;
let inflightPromise: Promise<PublicSettings | null> | null = null;
let inflightGeneration = -1;
let hasNetworkRefresh = false;
let lastNetworkRefreshAt = 0;
let cacheGeneration = 0;
const listeners = new Set<(settings: PublicSettings | null) => void>();

function sanitizePublicSettings(settings: PublicSettings): PublicSettings {
  return Object.fromEntries(
    Object.entries(settings).filter(([key]) => key !== 'subAgentAvatars'),
  ) as PublicSettings;
}

function settingsForSessionStorage(settings: PublicSettings): PublicSettings {
  return Object.fromEntries(
    Object.entries(sanitizePublicSettings(settings)).filter(([key]) => (
      key !== 'registrationMode'
      && key !== 'originMode'
      && key !== 'experimental'
      && key !== 'privateNetworkOnly'
      && key !== 'mail'
      && key !== 'appHosting'
    )),
  ) as PublicSettings;
}

function publishSettings(settings: PublicSettings | null) {
  cachedSettings = settings;
  if (typeof window !== 'undefined') {
    try {
      // Registration and host capabilities may change while this tab is
      // closed. Keep appearance data warm, but require network truth before
      // advertising signup or origin-dependent mutations each session.
      if (settings) sessionStorage.setItem(CACHE_KEY, JSON.stringify(settingsForSessionStorage(settings)));
      else sessionStorage.removeItem(CACHE_KEY);
    } catch {
      // Privacy modes may disable sessionStorage. The in-memory cache remains.
    }
  }
  listeners.forEach((fn) => fn(settings));
}

function primeFromSessionStorage(): PublicSettings | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sessionStorage.removeItem(CACHE_KEY);
      return null;
    }
    // Strip policy values and private sub-agent identifiers written by older Portal
    // versions before this cache became appearance-only. An unavailable settings
    // endpoint must fail registration closed.
    const settings = settingsForSessionStorage(parsed as PublicSettings);
    cachedSettings = settings;
    return settings;
  } catch {
    return null;
  }
}

async function fetchPublicSettings(options?: { revalidate?: boolean }): Promise<PublicSettings | null> {
  const revalidate = options?.revalidate === true;

  if (!revalidate) {
    if (cachedSettings !== undefined) return cachedSettings;
    const cached = primeFromSessionStorage();
    if (cached) return cached;
  } else if (cachedSettings === undefined) {
    primeFromSessionStorage();
  }

  const requestGeneration = cacheGeneration;
  if (inflightPromise && inflightGeneration === requestGeneration) return inflightPromise;

  const request = fetch('/api/settings/public', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
    .then((r) => {
      if (!r.ok) throw new Error(`Public settings request failed (${r.status})`);
      return r.json() as Promise<PublicSettings>;
    })
    .then((data) => {
      if (requestGeneration !== cacheGeneration) return cachedSettings ?? null;
      hasNetworkRefresh = true;
      lastNetworkRefreshAt = Date.now();
      const settings = data ? sanitizePublicSettings(data) : null;
      publishSettings(settings);
      return settings;
    })
    .catch(() => {
      return cachedSettings ?? null;
    })
    .finally(() => {
      if (inflightPromise === request) {
        inflightPromise = null;
        inflightGeneration = -1;
      }
    });
  inflightPromise = request;
  inflightGeneration = requestGeneration;

  return inflightPromise;
}

export function usePublicSettings() {
  const [settings, setSettings] = useState<PublicSettings | null>(() => {
    if (cachedSettings !== undefined) return cachedSettings;
    return primeFromSessionStorage();
  });

  useEffect(() => {
    listeners.add(setSettings);
    const revalidateIfStale = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (!hasNetworkRefresh || Date.now() - lastNetworkRefreshAt >= 5 * 60 * 1000) {
        void fetchPublicSettings({ revalidate: true });
      }
    };
    revalidateIfStale();
    window.addEventListener('focus', revalidateIfStale);
    document.addEventListener('visibilitychange', revalidateIfStale);
    return () => {
      listeners.delete(setSettings);
      window.removeEventListener('focus', revalidateIfStale);
      document.removeEventListener('visibilitychange', revalidateIfStale);
    };
  }, []);

  return settings;
}

export async function preloadPublicSettings() {
  return fetchPublicSettings();
}

export function invalidatePublicSettingsCache(): void {
  cacheGeneration += 1;
  cachedSettings = undefined;
  hasNetworkRefresh = false;
  lastNetworkRefreshAt = 0;
  if (typeof window !== 'undefined') {
    try { sessionStorage.removeItem(CACHE_KEY); } catch {}
  }
  listeners.forEach((fn) => fn(null));
}

export async function refreshPublicSettings(): Promise<PublicSettings | null> {
  invalidatePublicSettingsCache();
  return fetchPublicSettings({ revalidate: true });
}
