-- Client retries may repeat a message identifier, but one authenticated actor
-- in one immutable project may own only one persisted copy. Existing duplicate
-- rows were produced by pre-4.0 best-effort writes; retain the earliest row and
-- remove only later copies with the same non-null request identity.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "userId", "projectId", "messageId"
      ORDER BY "timestamp" ASC, "id" ASC
    ) AS duplicate_rank
  FROM "ProjectChatMessage"
  WHERE "messageId" IS NOT NULL
)
DELETE FROM "ProjectChatMessage" AS message
USING ranked
WHERE message."id" = ranked."id"
  AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX "ProjectChatMessage_userId_projectId_messageId_key"
  ON "ProjectChatMessage"("userId", "projectId", "messageId");
