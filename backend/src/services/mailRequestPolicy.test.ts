import {
  MAX_MAIL_SEARCH_CHARS,
  MAX_MAIL_SIGNATURE_CHARS,
  normalizeMailListRequest,
  normalizeMailSearchQuery,
  validateMailSignaturePayload,
} from './mailRequestPolicy';

describe('mailRequestPolicy', () => {
  test('normalizes valid pagination and rejects ambiguous or abusive values', () => {
    expect(normalizeMailListRequest({ position: '25', limit: '100', sort: 'date-asc' })).toEqual({
      position: 25,
      limit: 100,
      sort: 'date-asc',
    });
    expect(normalizeMailListRequest({})).toEqual({ position: 0, limit: 50, sort: 'date-desc' });
    expect(() => normalizeMailListRequest({ position: '-1' })).toThrow(/non-negative/);
    expect(() => normalizeMailListRequest({ limit: '101' })).toThrow(/outside/);
    expect(() => normalizeMailListRequest({ limit: 'NaN' })).toThrow(/non-negative/);
  });

  test('bounds plain-text and HTML signatures', () => {
    expect(validateMailSignaturePayload('Regards', '<b>Regards</b>')).toBeNull();
    expect(validateMailSignaturePayload({}, '')).toMatch(/must be text/);
    expect(validateMailSignaturePayload('', 'x'.repeat(MAX_MAIL_SIGNATURE_CHARS + 1))).toMatch(/exceeds/);
  });

  test('normalizes bounded full-mailbox search text', () => {
    expect(normalizeMailSearchQuery(undefined)).toBeUndefined();
    expect(normalizeMailSearchQuery('   ')).toBeUndefined();
    expect(normalizeMailSearchQuery('  invoice 2026  ')).toBe('invoice 2026');
    expect(() => normalizeMailSearchQuery(['invoice'])).toThrow('must be text');
    expect(() => normalizeMailSearchQuery('x'.repeat(MAX_MAIL_SEARCH_CHARS + 1))).toThrow('exceeds');
  });
});
