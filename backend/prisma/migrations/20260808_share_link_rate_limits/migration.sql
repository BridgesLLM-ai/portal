-- Existing links remain unlimited. A configured link owns one durable,
-- database-serialized fixed window so restarts cannot erase its request count.
--
-- Normalize legacy credential contradictions before installing the invariant.
-- Every repaired row is disabled so a changed access mode is never exposed
-- without an Owner deliberately reviewing and re-enabling it. Public links
-- with an empty-string residue remain public; they must not become private with
-- an unusable credential.
UPDATE "AppShareLink"
SET
  "isActive" = false,
  "isPublic" = true,
  "passwordHash" = NULL
WHERE
  (
    "isPublic" = false
    AND ("passwordHash" IS NULL OR length("passwordHash") = 0)
  )
  OR
  (
    "isPublic" = true
    AND "passwordHash" = ''
  );

UPDATE "AppShareLink"
SET
  "isActive" = false,
  "isPublic" = false
WHERE
  "isPublic" = true
  AND "passwordHash" IS NOT NULL
  AND length("passwordHash") > 0;

ALTER TABLE "AppShareLink"
  ADD COLUMN "rateLimitMaxRequests" INTEGER,
  ADD COLUMN "rateLimitWindowSeconds" INTEGER,
  ADD COLUMN "rateLimitRequestCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rateLimitWindowStartedAt" TIMESTAMP(3);

ALTER TABLE "AppShareLink"
  ADD CONSTRAINT "AppShareLink_rate_limit_policy_check"
    CHECK (
      (
        "rateLimitMaxRequests" IS NULL
        AND "rateLimitWindowSeconds" IS NULL
      )
      OR
      (
        "rateLimitMaxRequests" BETWEEN 1 AND 1000000
        AND "rateLimitWindowSeconds" IN (60, 300, 3600)
      )
    ),
  ADD CONSTRAINT "AppShareLink_rate_limit_count_check"
    CHECK ("rateLimitRequestCount" >= 0),
  ADD CONSTRAINT "AppShareLink_rate_limit_window_state_check"
    CHECK (
      "rateLimitWindowStartedAt" IS NOT NULL
      OR "rateLimitRequestCount" = 0
    ),
  ADD CONSTRAINT "AppShareLink_credential_state_check"
    CHECK (
      ("isPublic" = true AND "passwordHash" IS NULL)
      OR
      (
        "isPublic" = false
        AND "passwordHash" IS NOT NULL
        AND length("passwordHash") > 0
      )
    );
