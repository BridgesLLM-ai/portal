import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('Apps library share policy controls', () => {
  const source = fs.readFileSync(path.resolve(__dirname, 'AppsLibraryPage.tsx'), 'utf8');

  it('creates and edits bounded concurrent, audience, expiry, and request-rate policy', () => {
    expect(source).toContain('Concurrent visitors must be a whole number from 1 to 10,000');
    expect(source).toContain('...(maxConcurrentVisitors !== null ? { maxConcurrentVisitors } : {})');
    expect(source).toContain('aria-label="New app share concurrent visitor limit"');
    expect(source).toContain('aria-label="Edit app share concurrent visitor limit"');
    expect(source).toContain('aria-label="Edit app share API request count"');
    expect(source).toContain('rateLimitWindowSeconds: sharePolicyDraft.rateLimitEnabled');
    expect(source).toContain("setNotice('Share limits updated')");
  });
});
