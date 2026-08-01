-- Portal 4.0 auth/identity hardening. Collision checks intentionally run
-- before canonical backfill so an ambiguous identity aborts the migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "User"
    WHERE btrim("email") = '' OR btrim("username") = ''
  ) THEN
    RAISE EXCEPTION 'Cannot canonicalize User identity: blank email or username exists';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "RegistrationRequest"
    WHERE btrim("email") = ''
  ) THEN
    RAISE EXCEPTION 'Cannot canonicalize RegistrationRequest.email: blank email exists';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "MailboxAccount"
    WHERE btrim("username") = ''
  ) THEN
    RAISE EXCEPTION 'Cannot canonicalize MailboxAccount.username: blank username exists';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "User"
    GROUP BY lower(btrim("email"))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot canonicalize User.email: case/whitespace-insensitive collisions exist';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "User"
    GROUP BY lower(btrim("username"))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot canonicalize User.username: case/whitespace-insensitive collisions exist';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "RegistrationRequest"
    WHERE "status" = 'PENDING'
    GROUP BY lower(btrim("email"))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce one pending registration: canonical email collisions exist';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "MailboxAccount"
    GROUP BY lower(btrim("username"))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot canonicalize MailboxAccount.username: case/whitespace-insensitive collisions exist';
  END IF;
END $$;

UPDATE "User"
SET "email" = lower(btrim("email")),
    "username" = lower(btrim("username"))
WHERE "email" IS DISTINCT FROM lower(btrim("email"))
   OR "username" IS DISTINCT FROM lower(btrim("username"));

UPDATE "RegistrationRequest"
SET "email" = lower(btrim("email"))
WHERE "email" IS DISTINCT FROM lower(btrim("email"));

UPDATE "MailboxAccount"
SET "username" = lower(btrim("username"))
WHERE "username" IS DISTINCT FROM lower(btrim("username"));

ALTER TABLE "User"
  ADD CONSTRAINT "User_email_canonical_check"
    CHECK ("email" <> '' AND "email" = lower(btrim("email"))),
  ADD CONSTRAINT "User_username_canonical_check"
    CHECK ("username" <> '' AND "username" = lower(btrim("username"))),
  ADD COLUMN "twoFactorLastUsedStep" INTEGER;

ALTER TABLE "RegistrationRequest"
  ADD CONSTRAINT "RegistrationRequest_email_canonical_check"
    CHECK ("email" <> '' AND "email" = lower(btrim("email")));

ALTER TABLE "MailboxAccount"
  ADD CONSTRAINT "MailboxAccount_username_canonical_check"
    CHECK ("username" <> '' AND "username" = lower(btrim("username")));

CREATE UNIQUE INDEX "RegistrationRequest_one_pending_email"
  ON "RegistrationRequest" ("email")
  WHERE "status" = 'PENDING';

-- Bcrypt session/reset hashes cannot be converted without the raw token.
-- Invalidate them fail-closed; users sign in or request a reset again.
DELETE FROM "Session";
DELETE FROM "PasswordResetToken";

ALTER TABLE "EmailVerificationCode"
  ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'legacy';

CREATE INDEX "EmailVerificationCode_userId_purpose_createdAt_idx"
  ON "EmailVerificationCode"("userId", "purpose", "createdAt");

CREATE TABLE "TwoFactorChallenge" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TwoFactorChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TwoFactorChallenge_tokenHash_key"
  ON "TwoFactorChallenge"("tokenHash");
CREATE INDEX "TwoFactorChallenge_userId_idx"
  ON "TwoFactorChallenge"("userId");
CREATE INDEX "TwoFactorChallenge_expiresAt_idx"
  ON "TwoFactorChallenge"("expiresAt");
ALTER TABLE "TwoFactorChallenge"
  ADD CONSTRAINT "TwoFactorChallenge_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Normalize existing mailbox rows first. The partial unique index enforces the
-- at-most-one half; the deferred trigger checks the at-least-one half at commit.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (
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
  ON "MailboxAccount"("userId") WHERE "isPrimary" = true;

CREATE OR REPLACE FUNCTION portal_check_mailbox_primary(target_user_id TEXT)
RETURNS VOID AS $$
DECLARE
  mailbox_count INTEGER;
  primary_count INTEGER;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE "isPrimary")
    INTO mailbox_count, primary_count
  FROM "MailboxAccount"
  WHERE "userId" = target_user_id;

  IF mailbox_count > 0 AND primary_count <> 1 THEN
    RAISE EXCEPTION 'Mailbox primary invariant violated for Portal user'
      USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION portal_enforce_mailbox_primary()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM portal_check_mailbox_primary(NEW."userId");
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM portal_check_mailbox_primary(OLD."userId");
  ELSE
    PERFORM portal_check_mailbox_primary(OLD."userId");
    IF NEW."userId" IS DISTINCT FROM OLD."userId" THEN
      PERFORM portal_check_mailbox_primary(NEW."userId");
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "MailboxAccount_exactly_one_primary"
AFTER INSERT OR UPDATE OR DELETE ON "MailboxAccount"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION portal_enforce_mailbox_primary();
