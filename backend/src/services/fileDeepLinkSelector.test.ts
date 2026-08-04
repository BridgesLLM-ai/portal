import path from 'path';
import { normalizeOwnedFileDeepLinkPath } from './fileDeepLinkSelector';

const roots = {
  canonicalUploadsRoot: '/var/portal-files/user-owner-1/uploads',
  mediaMirrorUploadsRoot: '/root/.openclaw/media/portal-files/user-owner-1/uploads',
  legacyOwnerRoot: '/portal/files/owner-1',
};

describe('normalizeOwnedFileDeepLinkPath', () => {
  test('maps only exact actor-owned physical roots to the stored relative path', () => {
    expect(normalizeOwnedFileDeepLinkPath(
      '/var/portal-files/user-owner-1/uploads/reports/final.pdf',
      roots,
    )).toBe('reports/final.pdf');
    expect(normalizeOwnedFileDeepLinkPath(
      '/root/.openclaw/media/portal-files/user-owner-1/uploads/final.pdf',
      roots,
    )).toBe('final.pdf');
    expect(normalizeOwnedFileDeepLinkPath(
      '/portal/files/owner-1/legacy/final.pdf',
      roots,
    )).toBe('legacy/final.pdf');
  });

  test('keeps an already-relative database path exact', () => {
    expect(normalizeOwnedFileDeepLinkPath('reports/final.pdf', roots)).toBe('reports/final.pdf');
    expect(normalizeOwnedFileDeepLinkPath('final.pdf', roots)).toBe('final.pdf');
  });

  test('maps legacy home aliases only through the exact actor mirror subtree', () => {
    for (const prefix of ['~/', '', '/']) {
      expect(normalizeOwnedFileDeepLinkPath(
        `${prefix}.openclaw/media/portal-files/user-owner-1/uploads/reports/final.pdf`,
        roots,
      )).toBe('reports/final.pdf');
    }
    expect(normalizeOwnedFileDeepLinkPath(
      'root/.openclaw/media/portal-files/user-owner-1/uploads/final.pdf',
      roots,
    )).toBe('final.pdf');
  });

  test('rejects cross-user and malformed legacy mirror aliases', () => {
    expect(normalizeOwnedFileDeepLinkPath(
      '~/.openclaw/media/portal-files/user-someone-else/uploads/final.pdf',
      roots,
    )).toBeNull();
    expect(normalizeOwnedFileDeepLinkPath(
      '~/.openclaw/media/portal-files/user-owner-1/uploads/../final.pdf',
      roots,
    )).toBeNull();
    expect(normalizeOwnedFileDeepLinkPath(
      '~/.openclaw/media/portal-files/user-owner-1/uploadsevil/final.pdf',
      roots,
    )).toBeNull();
  });

  test('does not reinterpret a default-root spelling on a custom mirror root', () => {
    expect(normalizeOwnedFileDeepLinkPath(
      'root/.openclaw/media/portal-files/user-owner-1/uploads/final.pdf',
      {
        ...roots,
        mediaMirrorUploadsRoot: '/srv/openclaw/media/portal-files/user-owner-1/uploads',
      },
    )).toBeNull();
  });

  test('never falls back to a basename across owners or unrelated roots', () => {
    expect(normalizeOwnedFileDeepLinkPath(
      '/var/portal-files/user-someone-else/uploads/final.pdf',
      roots,
    )).toBeNull();
    expect(normalizeOwnedFileDeepLinkPath('/tmp/final.pdf', roots)).toBeNull();
  });

  test('rejects traversal, empty segments, and prefix-confused roots', () => {
    expect(normalizeOwnedFileDeepLinkPath('../final.pdf', roots)).toBeNull();
    expect(normalizeOwnedFileDeepLinkPath('reports//final.pdf', roots)).toBeNull();
    expect(normalizeOwnedFileDeepLinkPath(
      `${roots.canonicalUploadsRoot}${path.sep}..${path.sep}secret.pdf`,
      roots,
    )).toBeNull();
    expect(normalizeOwnedFileDeepLinkPath(
      '/var/portal-files/user-owner-1/uploadsevil/final.pdf',
      roots,
    )).toBeNull();
  });
});
