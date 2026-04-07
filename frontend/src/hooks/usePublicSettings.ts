import { useEffect, useState } from 'react';

export interface PublicSettings {
  portalName?: string;
  assistantName?: string;
  logoUrl?: string;
  theme?: 'dark' | 'light' | 'system';
  accentColor?: string;
  defaultOpenClawAgentId?: string;
  visibleBrowserOpenClawAgentId?: string;
  useDirectGateway?: boolean;
  agentAvatars?: Record<string, string>;
  subAgentAvatars?: Record<string, string>;
}

const CACHE_KEY = 'cached_publicSettings';

let cachedSettings: PublicSettings | null | undefined;
let inflightPromise: Promise<PublicSettings | null> | null = null;
const listeners = new Set<(settings: PublicSettings | null) => void>();

function publishSettings(settings: PublicSettings | null) {
  cachedSettings = settings;
  if (typeof window !== 'undefined') {
    if (settings) sessionStorage.setItem(CACHE_KEY, JSON.stringify(settings));
    else sessionStorage.removeItem(CACHE_KEY);
  }
  listeners.forEach((fn) => fn(settings));
}

function primeFromSessionStorage(): PublicSettings | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PublicSettings;
    cachedSettings = parsed;
    return parsed;
  } catch {
    return null;
  }
}

async function fetchPublicSettings(): Promise<PublicSettings | null> {
  if (cachedSettings !== undefined) return cachedSettings;
  const cached = primeFromSessionStorage();
  if (cached) return cached;
  if (inflightPromise) return inflightPromise;

  inflightPromise = fetch('/api/settings/public')
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      publishSettings(data || null);
      return data || null;
    })
    .catch(() => {
      publishSettings(null);
      return null;
    })
    .finally(() => {
      inflightPromise = null;
    });

  return inflightPromise;
}

export function usePublicSettings() {
  const [settings, setSettings] = useState<PublicSettings | null>(() => {
    if (cachedSettings !== undefined) return cachedSettings;
    return primeFromSessionStorage();
  });

  useEffect(() => {
    listeners.add(setSettings);
    if (cachedSettings === undefined) {
      void fetchPublicSettings();
    }
    return () => {
      listeners.delete(setSettings);
    };
  }, []);

  return settings;
}

export async function preloadPublicSettings() {
  return fetchPublicSettings();
}
