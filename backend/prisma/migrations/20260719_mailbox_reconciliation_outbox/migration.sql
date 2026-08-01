-- Durable desired-state mailbox reconciliation. The task row intentionally
-- contains no password or user foreign key: passwords stay encrypted on the
-- desired MailboxAccount row, while cascade deletes must leave a durable
-- username tombstone after both MailboxAccount and User are gone.
CREATE TABLE "MailboxReconciliationTask" (
  "username" TEXT NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseId" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MailboxReconciliationTask_pkey" PRIMARY KEY ("username"),
  CONSTRAINT "MailboxReconciliationTask_username_canonical_check"
    CHECK ("username" <> '' AND "username" = lower(btrim("username"))),
  CONSTRAINT "MailboxReconciliationTask_generation_check"
    CHECK ("generation" > 0),
  CONSTRAINT "MailboxReconciliationTask_attempts_check"
    CHECK ("attempts" >= 0),
  CONSTRAINT "MailboxReconciliationTask_status_check"
    CHECK ("status" IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'BLOCKED')),
  CONSTRAINT "MailboxReconciliationTask_error_code_check"
    CHECK ("lastErrorCode" IS NULL OR char_length("lastErrorCode") <= 64)
);

CREATE INDEX "MailboxReconciliationTask_status_nextAttemptAt_idx"
  ON "MailboxReconciliationTask"("status", "nextAttemptAt");
CREATE INDEX "MailboxReconciliationTask_leaseExpiresAt_idx"
  ON "MailboxReconciliationTask"("leaseExpiresAt");

CREATE OR REPLACE FUNCTION portal_enqueue_mailbox_reconciliation(target_username TEXT)
RETURNS VOID AS $$
DECLARE
  canonical_username TEXT := lower(btrim(target_username));
BEGIN
  IF canonical_username IS NULL OR canonical_username = '' THEN
    RAISE EXCEPTION 'Cannot enqueue reconciliation for a blank mailbox username'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO "MailboxReconciliationTask" (
    "username", "generation", "status", "attempts", "nextAttemptAt",
    "createdAt", "updatedAt"
  ) VALUES (
    canonical_username, 1, 'PENDING', 0, CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("username") DO UPDATE SET
    "generation" = "MailboxReconciliationTask"."generation" + 1,
    "status" = 'PENDING',
    "attempts" = 0,
    "nextAttemptAt" = CURRENT_TIMESTAMP,
    "lastErrorCode" = NULL,
    "lastErrorAt" = NULL,
    "completedAt" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION portal_mailbox_reconciliation_insert()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM portal_enqueue_mailbox_reconciliation(NEW."username");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION portal_mailbox_reconciliation_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."username" IS DISTINCT FROM OLD."username" THEN
    PERFORM portal_enqueue_mailbox_reconciliation(OLD."username");
  END IF;
  PERFORM portal_enqueue_mailbox_reconciliation(NEW."username");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION portal_mailbox_reconciliation_delete()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM portal_enqueue_mailbox_reconciliation(OLD."username");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MailboxAccount_enqueue_reconciliation_insert"
AFTER INSERT ON "MailboxAccount"
FOR EACH ROW EXECUTE FUNCTION portal_mailbox_reconciliation_insert();

CREATE TRIGGER "MailboxAccount_enqueue_reconciliation_update"
AFTER UPDATE OF "username", "mailPassword" ON "MailboxAccount"
FOR EACH ROW EXECUTE FUNCTION portal_mailbox_reconciliation_update();

CREATE TRIGGER "MailboxAccount_enqueue_reconciliation_delete"
AFTER DELETE ON "MailboxAccount"
FOR EACH ROW EXECUTE FUNCTION portal_mailbox_reconciliation_delete();

-- Every existing desired mailbox receives a first startup reconciliation.
INSERT INTO "MailboxReconciliationTask" (
  "username", "generation", "status", "attempts", "nextAttemptAt",
  "createdAt", "updatedAt"
)
SELECT
  "username", 1, 'PENDING', 0, CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "MailboxAccount"
ON CONFLICT ("username") DO NOTHING;
