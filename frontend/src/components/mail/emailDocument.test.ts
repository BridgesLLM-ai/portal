import { describe, expect, it } from 'vitest';
import { buildEmailDocument, containsRemoteMailContent } from './emailDocument';

describe('sandboxed email document policy', () => {
  it('blocks remote requests by default while retaining inline/data content', () => {
    const document = buildEmailDocument('<img src="https://tracker.example/pixel">', true, false);
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("img-src data: blob: cid:");
    expect(document).not.toContain('img-src http: https:');
    expect(document).toContain('name="referrer" content="no-referrer"');
  });

  it('allows only explicit public web resource schemes after user opt-in', () => {
    const document = buildEmailDocument('<img src="https://images.example/photo">', true, true);
    expect(document).toContain('img-src http: https: data: blob: cid:');
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("form-action 'none'");
  });

  it('detects common remote image and stylesheet patterns and escapes plain text', () => {
    expect(containsRemoteMailContent('<img src="https://tracker.example/pixel">')).toBe(true);
    expect(containsRemoteMailContent('<img srcset="https://tracker.example/retina 2x">')).toBe(true);
    expect(containsRemoteMailContent('<video poster="//tracker.example/poster">')).toBe(true);
    expect(containsRemoteMailContent('<style>@import url(//cdn.example/mail.css)</style>')).toBe(true);
    expect(containsRemoteMailContent('<img src="data:image/png;base64,abc">')).toBe(false);
    expect(buildEmailDocument('<script>alert(1)</script>', false, false)).toContain('&lt;script&gt;');
  });
});
