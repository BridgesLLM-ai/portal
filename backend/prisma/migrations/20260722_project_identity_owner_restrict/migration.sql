-- A User cascade must never erase the only durable attestation for a hidden
-- CREATING Project root. User retirement is disabled until it can explicitly
-- retire owner- and actor-scoped Portal 4 artifacts, so retain ProjectIdentity
-- as a database-level cross-process deletion fence.
BEGIN;

ALTER TABLE "ProjectIdentity"
  DROP CONSTRAINT "ProjectIdentity_workspaceOwnerId_fkey";

ALTER TABLE "ProjectIdentity"
  ADD CONSTRAINT "ProjectIdentity_workspaceOwnerId_fkey"
  FOREIGN KEY ("workspaceOwnerId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
