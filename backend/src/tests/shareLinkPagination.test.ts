import {
  ShareLinkPaginationError,
  buildShareLinkPage,
  decodeShareLinkCursor,
  encodeShareLinkCursor,
  parseShareLinkPagination,
  shareLinkCursorWhere,
} from '../utils/shareLinkPagination';

describe('share-link keyset pagination', () => {
  const tied = new Date('2026-08-20T20:00:00.000Z');

  test('round-trips an opaque ID-complete cursor and builds the matching strict range', () => {
    const encoded = encodeShareLinkCursor({ createdAt: tied, id: 'link-b' });
    expect(encoded).not.toContain('link-b');
    const cursor = decodeShareLinkCursor(encoded);
    expect(cursor).toEqual({ createdAt: tied, id: 'link-b' });
    expect(shareLinkCursorWhere(cursor)).toEqual({
      OR: [
        { createdAt: { lt: tied } },
        { createdAt: tied, id: { lt: 'link-b' } },
      ],
    });
  });

  test('returns limit+one metadata without exposing the sentinel row', () => {
    const rows = [
      { id: 'link-c', createdAt: tied },
      { id: 'link-b', createdAt: tied },
      { id: 'link-a', createdAt: tied },
    ];
    const page = buildShareLinkPage(rows, 2);
    expect(page.rows.map(row => row.id)).toEqual(['link-c', 'link-b']);
    expect(page.pagination).toEqual({
      hasMore: true,
      nextCursor: expect.any(String),
      limit: 2,
    });
    expect(decodeShareLinkCursor(page.pagination.nextCursor!)).toEqual({
      createdAt: tied,
      id: 'link-b',
    });
  });

  test('bounds page size and rejects arrays, malformed JSON, noncanonical timestamps, and extra fields', () => {
    expect(parseShareLinkPagination({})).toEqual({ limit: 100, cursor: null });
    expect(parseShareLinkPagination({ limit: '17' })).toEqual({ limit: 17, cursor: null });
    for (const query of [
      { limit: '0' },
      { limit: '101' },
      { limit: '1.5' },
      { limit: ['10'] },
      { cursor: ['abc'] },
      { cursor: '%' },
      { cursor: Buffer.from('{bad json', 'utf8').toString('base64url') },
      { cursor: Buffer.from(JSON.stringify({ v: 1, t: '2026-08-20', i: 'id' }), 'utf8').toString('base64url') },
      { cursor: Buffer.from(JSON.stringify({ v: 1, t: tied.toISOString(), i: 'id', extra: true }), 'utf8').toString('base64url') },
    ]) {
      expect(() => parseShareLinkPagination(query)).toThrow(ShareLinkPaginationError);
    }
  });

  test('terminates a complete page with no continuation cursor', () => {
    const page = buildShareLinkPage([{ id: 'link-a', createdAt: tied }], 2);
    expect(page.pagination).toEqual({ hasMore: false, nextCursor: null, limit: 2 });
  });
});
