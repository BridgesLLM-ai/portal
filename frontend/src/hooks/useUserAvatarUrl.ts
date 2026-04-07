import { useEffect, useState } from 'react';

const CACHE_KEY = 'cached_userAvatar';

let cachedUserAvatarUrl: string | null | undefined;
let inflightPromise: Promise<string | null> | null = null;
const listeners = new Set<(avatarUrl: string | null) => void>();

function publishUserAvatarUrl(avatarUrl: string | null) {
  cachedUserAvatarUrl = avatarUrl;
  listeners.forEach((listener) => listener(avatarUrl));
}

function primeFromSessionStorage(): string | null {
  if (typeof window === 'undefined') return null;
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) {
    cachedUserAvatarUrl = cached;
    return cached;
  }
  return null;
}

async function fetchUserAvatarUrl(): Promise<string | null> {
  if (cachedUserAvatarUrl !== undefined) return cachedUserAvatarUrl;
  const cached = primeFromSessionStorage();
  if (cached) return cached;
  if (inflightPromise) return inflightPromise;

  inflightPromise = fetch('/api/users/me/avatar', { headers: {} })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      const avatarUrl = typeof data?.avatarUrl === 'string' ? data.avatarUrl : null;
      if (typeof window !== 'undefined') {
        if (avatarUrl) sessionStorage.setItem(CACHE_KEY, avatarUrl);
        else sessionStorage.removeItem(CACHE_KEY);
      }
      publishUserAvatarUrl(avatarUrl);
      return avatarUrl;
    })
    .catch(() => {
      publishUserAvatarUrl(null);
      return null;
    })
    .finally(() => {
      inflightPromise = null;
    });

  return inflightPromise;
}

export function setCachedUserAvatarUrl(avatarUrl: string | null, persistedUrl?: string | null) {
  const storageUrl = persistedUrl === undefined ? avatarUrl : persistedUrl;
  if (typeof window !== 'undefined') {
    if (storageUrl) sessionStorage.setItem(CACHE_KEY, storageUrl);
    else sessionStorage.removeItem(CACHE_KEY);
  }
  publishUserAvatarUrl(avatarUrl);
}

export function useUserAvatarUrl(options?: { enabled?: boolean }) {
  const enabled = options?.enabled !== false;
  const [avatarUrl, setAvatarUrl] = useState<string | null>(() => {
    if (cachedUserAvatarUrl !== undefined) return cachedUserAvatarUrl;
    return primeFromSessionStorage();
  });

  useEffect(() => {
    listeners.add(setAvatarUrl);
    if (enabled) {
      void fetchUserAvatarUrl();
    }
    return () => {
      listeners.delete(setAvatarUrl);
    };
  }, [enabled]);

  return avatarUrl;
}
