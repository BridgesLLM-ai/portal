-- Project Chat history must decide which row IDs are safe before PostgreSQL
-- detoasts content or the client driver parses JSONB presentation data. Keep a
-- database-owned logical UTF-8 byte attestation that changes atomically with
-- every insert/update, including writes from older Portal processes.
ALTER TABLE "ProjectChatMessage"
  ADD COLUMN "logicalBytes" BIGINT GENERATED ALWAYS AS (
    octet_length("id")::BIGINT
    + octet_length("projectId")::BIGINT
    + octet_length("userId")::BIGINT
    + octet_length("sessionKey")::BIGINT
    + octet_length("role")::BIGINT
    + octet_length("content")::BIGINT
    + COALESCE(octet_length("messageId")::BIGINT, 0)
    + octet_length("provider")::BIGINT
    + octet_length("runtime")::BIGINT
    + COALESCE(octet_length("model")::BIGINT, 0)
    + COALESCE(octet_length("providerSessionId")::BIGINT, 0)
    + COALESCE(octet_length("turnId")::BIGINT, 0)
    + COALESCE(octet_length("presentation"::TEXT)::BIGINT, 0)
    + COALESCE(octet_length("sourceSortKey")::BIGINT, 0)
  ) STORED;

-- Do not destroy or rewrite an old oversized transcript during upgrade. A NOT
-- VALID check still rejects every new row and every update that leaves a row
-- oversized. The bounded reader emits an explicit placeholder for any legacy
-- row that predates this constraint.
ALTER TABLE "ProjectChatMessage"
  ADD CONSTRAINT "ProjectChatMessage_logicalBytes_write_limit"
  CHECK ("logicalBytes" BETWEEN 0 AND 2097152) NOT VALID;

-- The old index omitted the final unique key, so a large equal-timestamp /
-- equal-sort-key group could not be paged without offset scans or skipped IDs.
DROP INDEX IF EXISTS "ProjectChatMessage_userId_projectId_timestamp_sourceSortKey_idx";
CREATE INDEX "ProjectChatMessage_history_keyset_idx"
  ON "ProjectChatMessage" (
    "userId",
    "projectId",
    "timestamp" DESC,
    "sourceSortKey" DESC NULLS FIRST,
    "id" DESC
  );
