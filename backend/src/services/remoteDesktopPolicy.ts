const DEFAULT_AUDIO_PORT = 4714;

export const MAX_REMOTE_DESKTOP_CLIPBOARD_BYTES = 1024 * 1024;
export const MAX_SHARED_BROWSER_URL_LENGTH = 2048;
export const MAX_AGENT_BROWSER_BUFFERED_BYTES = 4 * 1024 * 1024;

export function normalizeAudioProxyPort(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= 65535
    ? value
    : DEFAULT_AUDIO_PORT;
}

export function isExactWebSocketPath(rawUrl: string | undefined, expectedPath: string): boolean {
  if (!rawUrl) return false;
  try {
    return new URL(rawUrl, 'http://portal.invalid').pathname === expectedPath;
  } catch {
    return false;
  }
}

export type SharedBrowserUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

export function validateSharedBrowserUrl(raw: unknown): SharedBrowserUrlResult {
  if (raw === undefined || raw === null || raw === '') return { ok: true, url: '' };
  if (typeof raw !== 'string') return { ok: false, error: 'Browser URL must be a string' };

  const value = raw.trim();
  if (!value) return { ok: true, url: '' };
  if (value.length > MAX_SHARED_BROWSER_URL_LENGTH) {
    return { ok: false, error: 'Browser URL is too long' };
  }

  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { ok: false, error: 'Browser URL must use http or https' };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, error: 'Browser URL must not contain embedded credentials' };
    }
    return { ok: true, url: parsed.toString() };
  } catch {
    return { ok: false, error: 'Browser URL is invalid' };
  }
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function remoteDesktopPathMatchesPrefix(pathname: string, prefix: string): boolean {
  const normalized = prefix.length > 1 && prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return pathname === normalized || pathname.startsWith(`${normalized}/`);
}

export function normalizeRemoteDesktopAllowedPrefixes(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return [...new Set(raw.split(',').map((entry) => entry.trim()).filter((entry) => (
    entry.length > 1
    && entry.startsWith('/')
    && !entry.startsWith('//')
    && !entry.includes('..')
    && !/[?#\\\u0000-\u001f\u007f]/.test(entry)
  )).map((entry) => entry.endsWith('/') ? entry.slice(0, -1) : entry))];
}
