import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  invalidatePublicSettingsCache,
  preloadPublicSettings,
  refreshPublicSettings,
} from './usePublicSettings';

function installSessionStorage() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() { return values.size; },
  } as Storage;
  vi.stubGlobal('window', { sessionStorage: storage });
  vi.stubGlobal('sessionStorage', storage);
  return storage;
}

describe('public settings cache lifecycle', () => {
  afterEach(() => {
    invalidatePublicSettingsCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('forces a fresh branding request after setup completes in the same SPA', async () => {
    installSessionStorage();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ portalName: 'Bootstrap default', logoUrl: '' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ portalName: 'Acme Portal', logoUrl: '/static-assets/branding/portal-logo-new.png' }) });
    vi.stubGlobal('fetch', fetchMock);

    expect(await preloadPublicSettings()).toMatchObject({ portalName: 'Bootstrap default' });
    expect(await refreshPublicSettings()).toMatchObject({
      portalName: 'Acme Portal',
      logoUrl: '/static-assets/branding/portal-logo-new.png',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ cache: 'no-store' });
  });

  it('does not mark a failed bootstrap request as a successful network refresh', async () => {
    installSessionStorage();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ portalName: 'Recovered' }) });
    vi.stubGlobal('fetch', fetchMock);

    expect(await preloadPublicSettings()).toBeNull();
    expect(await refreshPublicSettings()).toMatchObject({ portalName: 'Recovered' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('persists appearance without caching registration authorization across sessions', async () => {
    const storage = installSessionStorage();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ portalName: 'Acme Portal', registrationMode: 'open' }),
    }));

    expect(await preloadPublicSettings()).toMatchObject({ registrationMode: 'open' });
    expect(JSON.parse(storage.getItem('cached_publicSettings') ?? '{}')).toEqual({
      portalName: 'Acme Portal',
    });
  });

  it('strips registration authorization left by an older cached settings payload', async () => {
    const storage = installSessionStorage();
    storage.setItem('cached_publicSettings', JSON.stringify({
      portalName: 'Legacy Portal',
      registrationMode: 'open',
      subAgentAvatars: { 'private-agent': '/private-avatar.png' },
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await preloadPublicSettings()).toEqual({ portalName: 'Legacy Portal' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects sub-agent identifiers even if a stale server sends them publicly', async () => {
    const storage = installSessionStorage();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        portalName: 'Acme Portal',
        subAgentAvatars: { 'private-agent': '/private-avatar.png' },
      }),
    }));

    expect(await preloadPublicSettings()).toEqual({ portalName: 'Acme Portal' });
    expect(storage.getItem('cached_publicSettings')).not.toContain('private-agent');
  });

  it('publishes origin capabilities from the network without persisting stale authorization', async () => {
    const storage = installSessionStorage();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        portalName: 'Private Portal',
        originMode: 'tailnet',
        experimental: true,
        privateNetworkOnly: true,
        mail: { available: false, reason: 'Mail requires a public domain.' },
        appHosting: { available: false, reason: 'Hosted apps require a separate origin.' },
      }),
    }));

    expect(await preloadPublicSettings()).toMatchObject({
      originMode: 'tailnet',
      experimental: true,
      privateNetworkOnly: true,
      mail: { available: false },
      appHosting: { available: false },
    });
    expect(JSON.parse(storage.getItem('cached_publicSettings') ?? '{}')).toEqual({
      portalName: 'Private Portal',
    });
  });
});
