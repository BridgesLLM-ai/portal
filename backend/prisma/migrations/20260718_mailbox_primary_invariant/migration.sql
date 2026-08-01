-- Normalize existing mailbox rows so each user with mailboxes has exactly one
-- primary mailbox, then encode the at-most-one half of that invariant in the
-- database. Application transactions select a replacement when one is removed.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "userId"
      ORDER BY "isPrimary" DESC, "createdAt" ASC, "id" ASC
    ) AS primary_rank
  FROM "MailboxAccount"
)
UPDATE "MailboxAccount" AS mailbox
SET "isPrimary" = (ranked.primary_rank = 1)
FROM ranked
WHERE mailbox."id" = ranked."id"
  AND mailbox."isPrimary" IS DISTINCT FROM (ranked.primary_rank = 1);

CREATE UNIQUE INDEX IF NOT EXISTS "MailboxAccount_one_primary_per_user"
ON "MailboxAccount" ("userId")
WHERE "isPrimary" = true;
