import {
  MAX_REMOTE_DESKTOP_CLIPBOARD_BYTES,
  isExactWebSocketPath,
  normalizeAudioProxyPort,
  normalizeRemoteDesktopAllowedPrefixes,
  remoteDesktopPathMatchesPrefix,
  utf8ByteLength,
  validateSharedBrowserUrl,
} from './remoteDesktopPolicy';

describe('Remote Desktop boundary policy', () => {
  test('accepts only the exact websocket endpoint, with an optional query string', () => {
    expect(isExactWebSocketPath('/novnc/audio', '/novnc/audio')).toBe(true);
    expect(isExactWebSocketPath('/novnc/audio?attempt=2', '/novnc/audio')).toBe(true);
    expect(isExactWebSocketPath('/novnc/audio/extra', '/novnc/audio')).toBe(false);
    expect(isExactWebSocketPath('/novnc/audio-evil', '/novnc/audio')).toBe(false);
  });

  test('clamps invalid audio ports to the loopback proxy default', () => {
    expect(normalizeAudioProxyPort('4715')).toBe(4715);
    expect(normalizeAudioProxyPort('1.5')).toBe(4714);
    expect(normalizeAudioProxyPort('65536')).toBe(4714);
    expect(normalizeAudioProxyPort('not-a-port')).toBe(4714);
  });

  test('allows only bounded credential-free HTTP(S) browser URLs', () => {
    expect(validateSharedBrowserUrl(undefined)).toEqual({ ok: true, url: '' });
    expect(validateSharedBrowserUrl('https://example.com/docs')).toEqual({ ok: true, url: 'https://example.com/docs' });
    expect(validateSharedBrowserUrl('https://user:pass@example.com')).toEqual({ ok: false, error: 'Browser URL must not contain embedded credentials' });
    expect(validateSharedBrowserUrl('file:///etc/passwd')).toEqual({ ok: false, error: 'Browser URL must use http or https' });
    expect(validateSharedBrowserUrl(`https://example.com/${'a'.repeat(2048)}`)).toEqual({ ok: false, error: 'Browser URL is too long' });
  });

  test('uses path-segment boundaries rather than permissive string prefixes', () => {
    expect(remoteDesktopPathMatchesPrefix('/novnc', '/novnc')).toBe(true);
    expect(remoteDesktopPathMatchesPrefix('/novnc/vnc_portal.html', '/novnc')).toBe(true);
    expect(remoteDesktopPathMatchesPrefix('/novncevil', '/novnc')).toBe(false);
  });

  test('drops unsafe legacy path-prefix settings and normalizes safe entries', () => {
    expect(normalizeRemoteDesktopAllowedPrefixes('/novnc/, /vnc, /novnc')).toEqual(['/novnc', '/vnc']);
    expect(normalizeRemoteDesktopAllowedPrefixes('/, //evil, /../api, /novnc?next=/api, /safe\\escape')).toEqual([]);
  });

  test('enforces clipboard size by encoded bytes, not UTF-16 code units', () => {
    const oversizedUnicode = '🚀'.repeat(Math.floor(MAX_REMOTE_DESKTOP_CLIPBOARD_BYTES / 4) + 1);
    expect(oversizedUnicode.length).toBeLessThan(MAX_REMOTE_DESKTOP_CLIPBOARD_BYTES);
    expect(utf8ByteLength(oversizedUnicode)).toBeGreaterThan(MAX_REMOTE_DESKTOP_CLIPBOARD_BYTES);
  });
});
