import { useEffect, useState } from 'react';

export interface PublicSettings {
  portalName?: string;
  assistantName?: string;
  logoUrl?: string;
}

let cachedSettings: PublicSettings | null = null;
let inflightPromise: Promise<PublicSettings | null> | null = null;
let listeners = new Set<(settings: PublicSettings | null) => void>();

async function fetchPublicSettings(): Promise<PublicSettings | null> {
  if (cachedSettings) return cachedSettings;
  if (inflightPromise) return inflightPromise;

  inflightPromise = fetch('/api/settings/public')
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      cachedSettings = data;
      listeners.forEach((fn) => fn(cachedSettings));
      return cachedSettings;
    })
    .catch(() => null)
    .finally(() => {
      inflightPromise = null;
    });

  return inflightPromise;
}

export function usePublicSettings() {
  const [settings, setSettings] = useState<PublicSettings | null>(cachedSettings);

  useEffect(() => {
    listeners.add(setSettings);
    if (!cachedSettings) {
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
