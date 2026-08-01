-- Authoritative Portal 4 project creation uses CURRENT to distinguish a new
-- immutable identity from an existing filesystem root enrolled lazily as NONE.
-- Replace the closed-set constraint atomically; existing values and the NONE
-- column default remain unchanged.
ALTER TABLE "ProjectIdentity"
  DROP CONSTRAINT "ProjectIdentity_legacyOpenClawMigrationStatus_check",
  ADD CONSTRAINT "ProjectIdentity_legacyOpenClawMigrationStatus_check"
    CHECK ("legacyOpenClawMigrationStatus" IN ('NONE', 'PENDING', 'COMPLETE', 'CURRENT'));
