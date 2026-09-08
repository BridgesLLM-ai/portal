-- Existing links remain unlimited. When an Owner configures a concurrent
-- visitor cap, every in-flight public request owns one short-lived lease. The
-- link row is the cross-worker serialization point; expired rows are reclaimed
-- on the next admission after a process crash.
ALTER TABLE "AppShareLink"
  ADD COLUMN "maxConcurrentVisitors" INTEGER;

ALTER TABLE "AppShareLink"
  ADD CONSTRAINT "AppShareLink_max_concurrent_visitors_check"
  CHECK (
    "maxConcurrentVisitors" IS NULL
    OR "maxConcurrentVisitors" BETWEEN 1 AND 10000
  );

CREATE TABLE "AppShareRequestLease" (
  "leaseTokenHash" VARCHAR(64) NOT NULL,
  "shareLinkId" TEXT NOT NULL,
  "visitorIdHash" VARCHAR(64) NOT NULL,
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AppShareRequestLease_pkey" PRIMARY KEY ("leaseTokenHash"),
  CONSTRAINT "AppShareRequestLease_lease_token_hash_check"
    CHECK ("leaseTokenHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AppShareRequestLease_visitor_id_hash_check"
    CHECK ("visitorIdHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AppShareRequestLease_bounded_expiry_check"
    CHECK (
      "leaseExpiresAt" > "createdAt"
      AND "leaseExpiresAt" <= "createdAt" + INTERVAL '6 minutes'
    )
);

ALTER TABLE "AppShareRequestLease"
  ADD CONSTRAINT "AppShareRequestLease_shareLinkId_fkey"
  FOREIGN KEY ("shareLinkId") REFERENCES "AppShareLink"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "AppShareRequestLease_link_expiry_idx"
  ON "AppShareRequestLease"("shareLinkId", "leaseExpiresAt");
CREATE INDEX "AppShareRequestLease_link_visitor_expiry_idx"
  ON "AppShareRequestLease"("shareLinkId", "visitorIdHash", "leaseExpiresAt");
