import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';

/**
 * Project Chat history is a browser-facing read boundary, not an archival dump.
 * These limits are deliberately lower than PostgreSQL's TOAST limits so the
 * server proves a bounded ID set before the pg driver is allowed to decode a
 * `content` value or parse a JSONB `presentation` value.
 */
export const PROJECT_CHAT_HISTORY_ROW_LOGICAL_BYTE_LIMIT = 2 * 1024 * 1024;
export const PROJECT_CHAT_HISTORY_RESPONSE_LOGICAL_BYTE_LIMIT = 8 * 1024 * 1024;
export const PROJECT_CHAT_HISTORY_PLACEHOLDER_LOGICAL_BYTES = 512;
export const PROJECT_CHAT_HISTORY_OMITTED_PLACEHOLDER = '[chat.history omitted: message too large]';

type ProjectChatHistoryTransaction = {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
};

export type ProjectChatHistoryDatabase = {
  $transaction<T>(
    operation: (transaction: ProjectChatHistoryTransaction) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T>;
};

type ProjectChatHistoryCandidateRow = {
  id: string;
  timestamp: Date;
  logicalBytes: bigint | number | string;
  runningLogicalBytes: bigint | number | string;
  role: string;
  messageId: string | null;
  provider: string;
  runtime: string;
  model: string | null;
  providerSessionId: string | null;
  turnId: string | null;
};

type ProjectChatHistoryCursorRow = {
  id: string;
  timestamp: Date;
  sourceSortKey: string | null;
  sourceSortKeyOversized: boolean;
};

type ProjectChatHistoryHydratedRow = {
  id: string;
  role: string;
  content: string;
  timestamp: Date;
  messageId: string | null;
  provider: string;
  runtime: string;
  model: string | null;
  providerSessionId: string | null;
  turnId: string | null;
  presentation: unknown | null;
  logicalBytes: bigint | number | string;
};

export type ProjectChatHistoryMessageRow = ProjectChatHistoryHydratedRow & {
  contentTruncated?: true;
  truncationReason?: 'row_logical_byte_limit';
  originalLogicalBytes?: number;
};

export type ProjectChatHistoryPage = {
  messages: ProjectChatHistoryMessageRow[];
  hasMore: boolean;
  nextCursor: string | null;
  responseLogicalBytes: number;
  responseLogicalByteLimit: number;
  byteLimited: boolean;
  rowTruncationCount: number;
};

export class ProjectChatHistoryCursorError extends Error {
  constructor(message = 'Project Chat history cursor is invalid') {
    super(message);
    this.name = 'ProjectChatHistoryCursorError';
  }
}

function requiredIdentifier(value: unknown, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 512 || normalized.includes('\u0000')) {
    throw new ProjectChatHistoryCursorError(`${label} is invalid`);
  }
  return normalized;
}

function historyLimit(value: unknown): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > 100) {
    throw new ProjectChatHistoryCursorError('Project Chat history limit must be between 1 and 100');
  }
  return normalized;
}

function safeLogicalBytes(value: bigint | number | string): number {
  const normalized = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error('Project Chat history byte attestation is invalid');
  }
  return normalized;
}

function boundedScalar(value: unknown, fallback: string, maxLength: number): string {
  const normalized = typeof value === 'string' ? value : '';
  return normalized && normalized.length <= maxLength ? normalized : fallback;
}

function candidateProjection(): Prisma.Sql {
  return Prisma.sql`
    message."id",
    message."timestamp",
    message."sourceSortKey",
    message."logicalBytes",
    CASE
      WHEN octet_length(message."role") <= 32 THEN message."role"
      ELSE 'system'
    END AS "role",
    CASE
      WHEN message."messageId" IS NULL THEN NULL
      WHEN octet_length(message."messageId") <= 1024 THEN message."messageId"
      ELSE NULL
    END AS "messageId",
    CASE
      WHEN octet_length(message."provider") <= 64 THEN message."provider"
      ELSE 'OPENCLAW'
    END AS "provider",
    CASE
      WHEN octet_length(message."runtime") <= 256 THEN message."runtime"
      ELSE 'unavailable-project-runtime'
    END AS "runtime",
    CASE
      WHEN message."model" IS NULL THEN NULL
      WHEN octet_length(message."model") <= 512 THEN message."model"
      ELSE NULL
    END AS "model",
    CASE
      WHEN message."providerSessionId" IS NULL THEN NULL
      WHEN octet_length(message."providerSessionId") <= 1024 THEN message."providerSessionId"
      ELSE NULL
    END AS "providerSessionId",
    CASE
      WHEN message."turnId" IS NULL THEN NULL
      WHEN octet_length(message."turnId") <= 512 THEN message."turnId"
      ELSE NULL
    END AS "turnId"
  `;
}

function candidateBranch(input: {
  actorUserId: string;
  projectIdentityId: string;
  candidateLimit: number;
  where: Prisma.Sql;
}): Prisma.Sql {
  return Prisma.sql`(
    SELECT ${candidateProjection()}
    FROM "ProjectChatMessage" AS message
    WHERE message."userId" = ${input.actorUserId}
      AND message."projectId" = ${input.projectIdentityId}
      AND ${input.where}
    ORDER BY
      message."timestamp" DESC,
      message."sourceSortKey" DESC NULLS FIRST,
      message."id" DESC
    LIMIT ${input.candidateLimit}
  )`;
}

function candidateQuery(input: {
  actorUserId: string;
  projectIdentityId: string;
  cursor: ProjectChatHistoryCursorRow | null;
  candidateLimit: number;
}): Prisma.Sql {
  let source: Prisma.Sql;
  if (!input.cursor) {
    source = candidateBranch({ ...input, where: Prisma.sql`TRUE` });
  } else if (input.cursor.sourceSortKeyOversized) {
    // A pre-constraint pathological sort key is kept entirely inside
    // PostgreSQL. This rare compatibility path may scan more index entries,
    // but it remains ID-complete without transferring the oversized key.
    source = Prisma.sql`(
      SELECT ${candidateProjection()}
      FROM "ProjectChatMessage" AS message
      CROSS JOIN (
        SELECT "id", "timestamp", "sourceSortKey"
        FROM "ProjectChatMessage"
        WHERE "id" = ${input.cursor.id}
          AND "userId" = ${input.actorUserId}
          AND "projectId" = ${input.projectIdentityId}
      ) AS cursor
      WHERE message."userId" = ${input.actorUserId}
        AND message."projectId" = ${input.projectIdentityId}
        AND (
          message."timestamp" < cursor."timestamp"
          OR (
            message."timestamp" = cursor."timestamp"
            AND message."sourceSortKey" IS NOT NULL
            AND (
              message."sourceSortKey" < cursor."sourceSortKey"
              OR (
                message."sourceSortKey" = cursor."sourceSortKey"
                AND message."id" < cursor."id"
              )
            )
          )
        )
      ORDER BY
        message."timestamp" DESC,
        message."sourceSortKey" DESC NULLS FIRST,
        message."id" DESC
      LIMIT ${input.candidateLimit}
    )`;
  } else {
    const cursor = input.cursor;
    const branches = cursor.sourceSortKey === null
      ? [
          candidateBranch({
            ...input,
            where: Prisma.sql`
              message."timestamp" = ${cursor.timestamp}
              AND message."sourceSortKey" IS NULL
              AND message."id" < ${cursor.id}
            `,
          }),
          candidateBranch({
            ...input,
            where: Prisma.sql`
              message."timestamp" = ${cursor.timestamp}
              AND message."sourceSortKey" IS NOT NULL
            `,
          }),
          candidateBranch({
            ...input,
            where: Prisma.sql`message."timestamp" < ${cursor.timestamp}`,
          }),
        ]
      : [
          candidateBranch({
            ...input,
            where: Prisma.sql`
              message."timestamp" = ${cursor.timestamp}
              AND message."sourceSortKey" = ${cursor.sourceSortKey}
              AND message."id" < ${cursor.id}
            `,
          }),
          candidateBranch({
            ...input,
            where: Prisma.sql`
              message."timestamp" = ${cursor.timestamp}
              AND message."sourceSortKey" IS NOT NULL
              AND message."sourceSortKey" < ${cursor.sourceSortKey}
            `,
          }),
          candidateBranch({
            ...input,
            where: Prisma.sql`message."timestamp" < ${cursor.timestamp}`,
          }),
        ];
    source = Prisma.sql`${Prisma.join(branches, '\nUNION ALL\n')}`;
  }

  return Prisma.sql`
    WITH "candidate_rows" AS MATERIALIZED (
        SELECT *
        FROM (${source}) AS keyset_rows
        ORDER BY
          "timestamp" DESC,
          "sourceSortKey" DESC NULLS FIRST,
          "id" DESC
        LIMIT ${input.candidateLimit}
      ),
      "budgeted_rows" AS (
        SELECT
          candidate.*,
          SUM(
            CASE
              WHEN candidate."logicalBytes" BETWEEN 0 AND ${PROJECT_CHAT_HISTORY_ROW_LOGICAL_BYTE_LIMIT}
                THEN candidate."logicalBytes"
              ELSE ${PROJECT_CHAT_HISTORY_PLACEHOLDER_LOGICAL_BYTES}
            END
          ) OVER (
            ORDER BY
              candidate."timestamp" DESC,
              candidate."sourceSortKey" DESC NULLS FIRST,
              candidate."id" DESC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS "runningLogicalBytes"
        FROM "candidate_rows" AS candidate
      )
    SELECT
      "id",
      "timestamp",
      "logicalBytes",
      "runningLogicalBytes",
      "role",
      "messageId",
      "provider",
      "runtime",
      "model",
      "providerSessionId",
      "turnId"
    FROM "budgeted_rows"
    ORDER BY "timestamp" DESC, "sourceSortKey" DESC NULLS FIRST, "id" DESC
  `;
}

function hydrationQuery(input: {
  actorUserId: string;
  projectIdentityId: string;
  ids: readonly string[];
}): Prisma.Sql {
  return Prisma.sql`
    SELECT
      "id",
      "role",
      "content",
      "timestamp",
      "messageId",
      "provider",
      "runtime",
      "model",
      "providerSessionId",
      "turnId",
      "presentation",
      "logicalBytes"
    FROM "ProjectChatMessage"
    WHERE "userId" = ${input.actorUserId}
      AND "projectId" = ${input.projectIdentityId}
      AND "id" IN (${Prisma.join(input.ids)})
      AND "logicalBytes" BETWEEN 0 AND ${PROJECT_CHAT_HISTORY_ROW_LOGICAL_BYTE_LIMIT}
  `;
}

/**
 * Read a deterministic newest-first Project Chat page without materializing an
 * untrusted TOAST value before its database-maintained logical size is known.
 *
 * The cursor row and candidate IDs are selected from one repeatable snapshot.
 * The second query may parse JSONB only for the already-proven safe ID set.
 */
export async function readProjectChatHistoryPage(input: {
  actorUserId: string;
  projectIdentityId: string;
  beforeId?: string | null;
  limit: number;
}, database: ProjectChatHistoryDatabase = prisma as unknown as ProjectChatHistoryDatabase): Promise<ProjectChatHistoryPage> {
  const actorUserId = requiredIdentifier(input.actorUserId, 'actor user ID');
  const projectIdentityId = requiredIdentifier(input.projectIdentityId, 'project identity ID');
  const beforeId = input.beforeId == null ? null : requiredIdentifier(input.beforeId, 'history cursor');
  const limit = historyLimit(input.limit);

  return database.$transaction(async (transaction) => {
    let cursor: ProjectChatHistoryCursorRow | null = null;
    if (beforeId) {
      const rows = await transaction.$queryRaw<ProjectChatHistoryCursorRow[]>(Prisma.sql`
        SELECT
          "id",
          "timestamp",
          CASE
            WHEN "sourceSortKey" IS NULL THEN NULL
            WHEN octet_length("sourceSortKey") <= 4096 THEN "sourceSortKey"
            ELSE NULL
          END AS "sourceSortKey",
          COALESCE(octet_length("sourceSortKey") > 4096, FALSE) AS "sourceSortKeyOversized"
        FROM "ProjectChatMessage"
        WHERE "id" = ${beforeId}
          AND "userId" = ${actorUserId}
          AND "projectId" = ${projectIdentityId}
        LIMIT 1
      `);
      if (rows.length !== 1 || !(rows[0].timestamp instanceof Date)) {
        throw new ProjectChatHistoryCursorError();
      }
      cursor = rows[0];
    }

    const candidates = await transaction.$queryRaw<ProjectChatHistoryCandidateRow[]>(candidateQuery({
      actorUserId,
      projectIdentityId,
      cursor,
      candidateLimit: limit + 1,
    }));
    const withinBudget = candidates.filter((candidate) => (
      safeLogicalBytes(candidate.runningLogicalBytes) <= PROJECT_CHAT_HISTORY_RESPONSE_LOGICAL_BYTE_LIMIT
    ));
    const selected = withinBudget.slice(0, limit);
    const hasMore = candidates.length > selected.length;
    const byteLimited = candidates.length > withinBudget.length;
    const safeIds = selected
      .filter((candidate) => safeLogicalBytes(candidate.logicalBytes) <= PROJECT_CHAT_HISTORY_ROW_LOGICAL_BYTE_LIMIT)
      .map((candidate) => candidate.id);
    const hydrated = safeIds.length === 0
      ? []
      : await transaction.$queryRaw<ProjectChatHistoryHydratedRow[]>(hydrationQuery({
          actorUserId,
          projectIdentityId,
          ids: safeIds,
        }));
    const hydratedById = new Map(hydrated.map((row) => [row.id, row]));
    let rowTruncationCount = 0;
    const messages = selected.map((candidate): ProjectChatHistoryMessageRow => {
      const logicalBytes = safeLogicalBytes(candidate.logicalBytes);
      if (logicalBytes <= PROJECT_CHAT_HISTORY_ROW_LOGICAL_BYTE_LIMIT) {
        const row = hydratedById.get(candidate.id);
        if (!row || safeLogicalBytes(row.logicalBytes) !== logicalBytes) {
          throw new Error('Project Chat history changed during bounded hydration');
        }
        return row;
      }
      rowTruncationCount += 1;
      return {
        id: candidate.id,
        role: 'assistant',
        content: PROJECT_CHAT_HISTORY_OMITTED_PLACEHOLDER,
        timestamp: candidate.timestamp,
        messageId: candidate.messageId,
        provider: boundedScalar(candidate.provider, 'OPENCLAW', 64),
        runtime: boundedScalar(candidate.runtime, 'unavailable-project-runtime', 256),
        model: candidate.model,
        providerSessionId: candidate.providerSessionId,
        turnId: candidate.turnId,
        presentation: null,
        logicalBytes: PROJECT_CHAT_HISTORY_PLACEHOLDER_LOGICAL_BYTES,
        contentTruncated: true,
        truncationReason: 'row_logical_byte_limit',
        originalLogicalBytes: logicalBytes,
      };
    });
    const responseLogicalBytes = selected.length === 0
      ? 0
      : safeLogicalBytes(selected.at(-1)!.runningLogicalBytes);
    return {
      messages,
      hasMore,
      nextCursor: hasMore ? selected.at(-1)?.id || null : null,
      responseLogicalBytes,
      responseLogicalByteLimit: PROJECT_CHAT_HISTORY_RESPONSE_LOGICAL_BYTE_LIMIT,
      byteLimited,
      rowTruncationCount,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export const projectChatHistoryInternals = Object.freeze({
  candidateQuery,
  hydrationQuery,
});
