import { projectPortalAuthoredContent, projectPortalAuthoredText, signPortalResponseContext } from './portalResponseContext';

const request = 'portal-owned-request:client:message-1';
describe('model context vs authored conversation', () => {
  test('projects only the exact attested turn after live echo and history reload', () => {
    const authored = 'Draw a café diagram 🧭\nKeep this line.';
    const transmitted = signPortalResponseContext(authored, 'Server response guidance\n\n' + authored, request);
    expect(transmitted).toContain('Server response guidance');
    expect(projectPortalAuthoredText(transmitted, request)).toBe(authored);
    expect(projectPortalAuthoredText(transmitted, request + ':user')).toBe(authored);
  });

  test('does not strip quoted, forged, changed or replayed user text', () => {
    const signed = signPortalResponseContext('Hello', 'Response context\n\nHello', request);
    for (const text of [signed.replace('Hello', 'Different'), 'Here is a quote: ' + signed, signed.replace('authoredBytes=5', 'authoredBytes=1')]) {
      expect(projectPortalAuthoredText(text, request)).toBe(text);
    }
    expect(projectPortalAuthoredText(signed, 'portal-different-request:client:message-2')).toBe(signed);
    expect(projectPortalAuthoredText(signed, undefined)).toBe(signed);
    expect(projectPortalAuthoredText('[Portal response preference]\nMy own text', request)).toContain('My own text');
  });

  test('preserves authored text that itself quotes a previous authentic envelope', () => {
    const quote = signPortalResponseContext('Hello', 'Old context\nHello', request);
    const next = signPortalResponseContext(quote, 'New context\n' + quote, 'portal-next');
    expect(projectPortalAuthoredText(next, 'portal-next')).toBe(quote);
  });

  test('projects structured text before display trimming, preserving literal control words and whitespace', () => {
    const authored = '  Literal HEARTBEAT_OK and NO_REPLY\n\n';
    const signed = signPortalResponseContext(authored, 'Context\n' + authored, request);
    expect(projectPortalAuthoredContent([{ type: 'text', text: signed }], request)).toBe(authored);
    expect(projectPortalAuthoredContent([{ type: 'text', text: signed }], 'portal-other')).toBeNull();
  });

  test('refuses losing or substituting the authored suffix, or a non-Portal request', () => {
    expect(() => signPortalResponseContext('Original', 'Substitution', request)).toThrow('Invalid');
    expect(() => signPortalResponseContext('Hi', 'Context\nHi', 'foreign-key')).toThrow('Invalid');
    expect(signPortalResponseContext('Plain', 'Plain', request)).toBe('Plain');
  });
});
