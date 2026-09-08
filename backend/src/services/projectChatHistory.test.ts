import fs from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';

jest.mock('../config/database', () => ({ prisma: {} }));

import {
  PROJECT_CHAT_HISTORY_OMITTED_PLACEHOLDER,
  PROJECT_CHAT_HISTORY_RESPONSE_LOGICAL_BYTE_LIMIT,
  PROJECT_CHAT_HISTORY_ROW_LOGICAL_BYTE_LIMIT,
  ProjectChatHistoryCursorError,
  projectChatHistoryInternals,
  readProjectChatHistoryPage,
  type ProjectChatHistoryDatabase,
} from './projectChatHistory';

type Candidate = {
  id: string;
  timestamp: Date;
  logicalBytes: bigint;
  runningLogicalBytes: bigint;
  role: string;
  messageId: string;
  provider: string;
  runtime: string;
  model: string | null;
  providerSessionId: string | null;
  turnId: string | null;
};

function candidate(
  id: string,
  logicalBytes: number,
  runningLogicalBytes: number,
  timestamp = new Date('2026-08-20T12:00:00.000Z'),
): Candidate {
  return {
    id,
    timestamp,
    logicalBytes: BigInt(logicalBytes),
    runningLogicalBytes: BigInt(runningLogicalBytes),
    role: 'assistant',
    messageId: `message-${id}`,
    provider: 'OPENCLAW',
    runtime: 'openclaw-dedicated-project-agent',
    model: null,
    providerSessionId: `session-${id}`,
    turnId: `turn-${id}`,
  };
}

function hydrated(row: Candidate, content = `content-${row.id}`, presentation: unknown = null) {
  return {
    id: row.id,
    role: row.role,
    content,
    timestamp: row.timestamp,
    messageId: row.messageId,
    provider: row.provider,
    runtime: row.runtime,
    model: row.model,
    providerSessionId: row.providerSessionId,
    turnId: row.turnId,
    presentation,
    logicalBytes: row.logicalBytes,
  };
}

function queryText(query: Prisma.Sql): string {
  return query.strings.join('?');
}

function database(input: {
  candidates: Candidate[];
  hydrated?: ReturnType<typeof hydrated>[];
  cursorFound?: boolean;
}) {
  const calls: Prisma.Sql[] = [];
  const $queryRaw = jest.fn(async (query: Prisma.Sql) => {
    calls.push(query);
    const text = queryText(query);
    if (text.includes('AS "sourceSortKeyOversized"')) {
      return input.cursorFound === false ? [] : [{
        id: 'cursor',
        timestamp: new Date('2026-08-20T12:00:00.000Z'),
        sourceSortKey: null,
        sourceSortKeyOversized: false,
      }];
    }
    if (text.includes('FROM "budgeted_rows"')) return input.candidates;
    if (text.includes('"content"') && text.includes('"logicalBytes" BETWEEN')) {
      return input.hydrated || input.candidates
        .filter((row) => Number(row.logicalBytes) <= PROJECT_CHAT_HISTORY_ROW_LOGICAL_BYTE_LIMIT)
        .map((row) => hydrated(row));
    }
    throw new Error(`Unexpected Project Chat history query: ${text}`);
  });
  const $transaction = jest.fn(async (operation: (transaction: any) => Promise<unknown>) => (
    operation({ $queryRaw })
  ));
  return {
    database: { $transaction } as unknown as ProjectChatHistoryDatabase,
    calls,
    $queryRaw,
    $transaction,
  };
}

test('replaces a pre-constraint oversized row without hydrating content or parsing presentation', async () => {
  const oversized = candidate(
    'oversized',
    PROJECT_CHAT_HISTORY_ROW_LOGICAL_BYTE_LIMIT + 1,
    512,
  );
  const safe = candidate('safe', 64, 576);
  const harness = database({
    candidates: [oversized, safe],
    hydrated: [hydrated(safe, 'safe content', { version: 2 })],
  });

  const page = await readProjectChatHistoryPage({
    actorUserId: 'actor-1',
    projectIdentityId: 'project-1',
    limit: 100,
  }, harness.database);

  expect(page.messages).toHaveLength(2);
  expect(page.messages[0]).toMatchObject({
    id: 'oversized',
    role: 'assistant',
    content: PROJECT_CHAT_HISTORY_OMITTED_PLACEHOLDER,
    presentation: null,
    contentTruncated: true,
    truncationReason: 'row_logical_byte_limit',
    originalLogicalBytes: PROJECT_CHAT_HISTORY_ROW_LOGICAL_BYTE_LIMIT + 1,
  });
  expect(page.messages[1]).toMatchObject({ id: 'safe', content: 'safe content' });
  expect(page.rowTruncationCount).toBe(1);

  const candidateRead = harness.calls.find((query) => queryText(query).includes('FROM "budgeted_rows"'))!;
  expect(queryText(candidateRead)).not.toContain('message."content"');
  expect(queryText(candidateRead)).not.toContain('message."presentation"');
  expect(queryText(candidateRead)).toContain('SUM(');
  const hydration = harness.calls.find((query) => queryText(query).includes('AND "id" IN ('))!;
  expect(harness.calls.indexOf(candidateRead)).toBeLessThan(harness.calls.indexOf(hydration));
  expect(queryText(hydration)).toContain('AND "id" IN (?)');
  expect(hydration.values).toContain('safe');
  expect(hydration.values).not.toContain('oversized');
});

test('attests UTF-8 bytes in PostgreSQL rather than characters', () => {
  const migration = fs.readFileSync(path.resolve(
    __dirname,
    '../../prisma/migrations/20260820_project_chat_history_bytes_keyset/migration.sql',
  ), 'utf8');
  expect(Buffer.byteLength('😀', 'utf8')).toBe(4);
  expect('😀'.length).toBe(2);
  expect(migration).toContain('octet_length("content")::BIGINT');
  expect(migration).toContain('octet_length("presentation"::TEXT)::BIGINT');
  expect(migration).toContain('BIGINT GENERATED ALWAYS AS');
  expect(migration).toContain(') STORED;');
  expect(migration).not.toContain('+ length("content")');
  expect(migration).toContain('CHECK ("logicalBytes" BETWEEN 0 AND 2097152) NOT VALID');
});

test('uses an ID-complete NULLS FIRST keyset for arbitrarily large timestamp ties', () => {
  const query = projectChatHistoryInternals.candidateQuery({
    actorUserId: 'actor-1',
    projectIdentityId: 'project-1',
    cursor: {
      id: 'cursor-id',
      timestamp: new Date('2026-08-20T12:00:00.000Z'),
      sourceSortKey: null,
      sourceSortKeyOversized: false,
    },
    candidateLimit: 101,
  });
  const text = queryText(query);

  expect(text).toContain('message."timestamp" < ?');
  expect(text).toContain('message."sourceSortKey" IS NULL');
  expect(text).toContain('message."id" < ?');
  expect(text).toContain('message."sourceSortKey" IS NOT NULL');
  expect(text).toContain('UNION ALL');
  expect(text).toContain('message."sourceSortKey" DESC NULLS FIRST');
  expect(text).toContain('message."id" DESC');

  const migration = fs.readFileSync(path.resolve(
    __dirname,
    '../../prisma/migrations/20260820_project_chat_history_bytes_keyset/migration.sql',
  ), 'utf8');
  expect(migration).toContain('"timestamp" DESC');
  expect(migration).toContain('"sourceSortKey" DESC NULLS FIRST');
  expect(migration).toContain('"id" DESC');
});

test('keeps reconnect and upward pagination deterministic without losing tied IDs', async () => {
  const newest = candidate('tie-004', 64, 64);
  const second = candidate('tie-003', 64, 128);
  const pageOneSentinel = candidate('tie-002', 64, 192);
  const pageOne = database({ candidates: [newest, second, pageOneSentinel] });

  const first = await readProjectChatHistoryPage({
    actorUserId: 'actor-1',
    projectIdentityId: 'project-1',
    limit: 2,
  }, pageOne.database);
  const reconnect = await readProjectChatHistoryPage({
    actorUserId: 'actor-1',
    projectIdentityId: 'project-1',
    limit: 2,
  }, database({ candidates: [newest, second, pageOneSentinel] }).database);
  expect(first.messages.map((row) => row.id)).toEqual(['tie-004', 'tie-003']);
  expect(reconnect.messages.map((row) => row.id)).toEqual(['tie-004', 'tie-003']);
  expect(first.nextCursor).toBe('tie-003');
  expect(reconnect.nextCursor).toBe(first.nextCursor);

  const third = candidate('tie-002', 64, 64);
  const oldest = candidate('tie-001', 64, 128);
  const pageTwo = database({ candidates: [third, oldest], cursorFound: true });
  const secondPage = await readProjectChatHistoryPage({
    actorUserId: 'actor-1',
    projectIdentityId: 'project-1',
    beforeId: first.nextCursor,
    limit: 2,
  }, pageTwo.database);
  expect(secondPage.messages.map((row) => row.id)).toEqual(['tie-002', 'tie-001']);
  expect(new Set([...first.messages, ...secondPage.messages].map((row) => row.id)).size).toBe(4);
  expect(secondPage.hasMore).toBe(false);
  expect(pageTwo.$transaction).toHaveBeenCalledWith(
    expect.any(Function),
    { isolationLevel: 'RepeatableRead' },
  );
});

test('turns a response-byte stop into a resumable cursor instead of a false complete page', async () => {
  const rowBytes = PROJECT_CHAT_HISTORY_ROW_LOGICAL_BYTE_LIMIT;
  const candidates = Array.from({ length: 5 }, (_, index) => candidate(
    `row-${5 - index}`,
    rowBytes,
    rowBytes * (index + 1),
  ));
  const first = await readProjectChatHistoryPage({
    actorUserId: 'actor-1',
    projectIdentityId: 'project-1',
    limit: 100,
  }, database({ candidates }).database);
  expect(first.messages.map((row) => row.id)).toEqual(['row-5', 'row-4', 'row-3', 'row-2']);
  expect(first.responseLogicalBytes).toBe(PROJECT_CHAT_HISTORY_RESPONSE_LOGICAL_BYTE_LIMIT);
  expect(first.byteLimited).toBe(true);
  expect(first.hasMore).toBe(true);
  expect(first.nextCursor).toBe('row-2');

  const resumedCandidate = candidate('row-1', rowBytes, rowBytes);
  const resumed = await readProjectChatHistoryPage({
    actorUserId: 'actor-1',
    projectIdentityId: 'project-1',
    beforeId: first.nextCursor,
    limit: 100,
  }, database({ candidates: [resumedCandidate] }).database);
  expect(resumed.messages.map((row) => row.id)).toEqual(['row-1']);
  expect(resumed.hasMore).toBe(false);
  expect(resumed.nextCursor).toBeNull();
});

test('rejects a cross-project or deleted cursor before reading candidates', async () => {
  const harness = database({ candidates: [], cursorFound: false });
  await expect(readProjectChatHistoryPage({
    actorUserId: 'actor-1',
    projectIdentityId: 'project-1',
    beforeId: 'foreign-cursor',
    limit: 25,
  }, harness.database)).rejects.toBeInstanceOf(ProjectChatHistoryCursorError);
  expect(harness.$queryRaw).toHaveBeenCalledTimes(1);
});
