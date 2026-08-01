import { describe, expect, it } from 'vitest';
import { resolveSafePortalRedirect } from './authRedirect';

describe('post-login redirect validation', () => {
  const origin = 'https://portal.example.com';

  it('keeps same-origin application paths', () => {
    expect(resolveSafePortalRedirect('/projects?tab=files#latest', origin)).toBe('/projects?tab=files#latest');
  });

  it.each([
    'https://evil.example/path',
    '//evil.example/path',
    '/\\evil.example/path',
    '/%5cevil.example/path',
    'dashboard',
  ])('rejects unsafe redirect %s', (redirect) => {
    expect(resolveSafePortalRedirect(redirect, origin)).toBeNull();
  });
});
