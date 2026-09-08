import { Prisma } from '@prisma/client';

export const DEFAULT_SHARE_LINK_PAGE_LIMIT = 100;
export const MAX_SHARE_LINK_PAGE_LIMIT = 100;
const MAX_CURSOR_CHARS = 512;
const CURSOR_RE = /^[A-Za-z0-9_-]+$/;

export class ShareLinkPaginationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareLinkPaginationError';
  }
}

export interface ShareLinkCursor {
  createdAt: Date;
  id: string;
}

export interface ShareLinkPaginationRequest {
  limit: number;
  cursor: ShareLinkCursor | null;
}

function singleQueryValue(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ShareLinkPaginationError(`${name} must be a single string`);
  return value;
}

export function encodeShareLinkCursor(value: { createdAt: Date; id: string }): string {
  if (!(value.createdAt instanceof Date)
    || !Number.isFinite(value.createdAt.getTime())
    || typeof value.id !== 'string'
    || value.id.length < 1
    || value.id.length > 255) {
    throw new ShareLinkPaginationError('Cannot encode an invalid share-link cursor');
  }
  return Buffer.from(JSON.stringify({
    v: 1,
    t: value.createdAt.toISOString(),
    i: value.id,
  }), 'utf8').toString('base64url');
}

export function decodeShareLinkCursor(raw: string): ShareLinkCursor {
  if (raw.length < 1 || raw.length > MAX_CURSOR_CHARS || !CURSOR_RE.test(raw)) {
    throw new ShareLinkPaginationError('cursor is invalid');
  }
  try {
    const decoded = Buffer.from(raw, 'base64url');
    if (decoded.toString('base64url') !== raw) throw new Error('non-canonical cursor');
    const value = JSON.parse(decoded.toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid cursor object');
    const record = value as Record<string, unknown>;
    if (record.v !== 1
      || typeof record.t !== 'string'
      || typeof record.i !== 'string'
      || record.i.length < 1
      || record.i.length > 255
      || Object.keys(record).sort().join(',') !== 'i,t,v') {
      throw new Error('invalid cursor fields');
    }
    const createdAt = new Date(record.t);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== record.t) {
      throw new Error('invalid cursor timestamp');
    }
    return { createdAt, id: record.i };
  } catch {
    throw new ShareLinkPaginationError('cursor is invalid');
  }
}

export function parseShareLinkPagination(query: {
  limit?: unknown;
  cursor?: unknown;
}): ShareLinkPaginationRequest {
  const rawLimit = singleQueryValue(query.limit, 'limit');
  const rawCursor = singleQueryValue(query.cursor, 'cursor');
  const limit = rawLimit === undefined
    ? DEFAULT_SHARE_LINK_PAGE_LIMIT
    : (/^[1-9][0-9]*$/.test(rawLimit) ? Number(rawLimit) : Number.NaN);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SHARE_LINK_PAGE_LIMIT) {
    throw new ShareLinkPaginationError(`limit must be an integer from 1 to ${MAX_SHARE_LINK_PAGE_LIMIT}`);
  }
  return {
    limit,
    cursor: rawCursor === undefined ? null : decodeShareLinkCursor(rawCursor),
  };
}

export function shareLinkCursorWhere(cursor: ShareLinkCursor | null): Prisma.AppShareLinkWhereInput {
  if (!cursor) return {};
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

export function buildShareLinkPage<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
): {
  rows: T[];
  pagination: { hasMore: boolean; nextCursor: string | null; limit: number };
} {
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    rows: pageRows,
    pagination: {
      hasMore,
      nextCursor: hasMore && last ? encodeShareLinkCursor(last) : null,
      limit,
    },
  };
}
