BEGIN;

ALTER TABLE "ProjectIdentity"
  ADD COLUMN "dependencyQuarantinedAt" TIMESTAMP(3);

-- Existing contained rows predate the dedicated timestamp. Their last
-- lifecycle mutation is the narrowest durable lower bound available; repairs
-- still require a backup strictly newer than this value.
UPDATE "ProjectIdentity"
SET "dependencyQuarantinedAt" = "updatedAt"
WHERE "lifecycleStatus" = 'DEPENDENCY_QUARANTINED';

ALTER TABLE "ProjectIdentity"
  ADD CONSTRAINT "ProjectIdentity_dependency_quarantine_timestamp_check"
  CHECK (
    "lifecycleStatus" = 'DEPENDENCY_PROMOTING'
    OR ("lifecycleStatus" = 'DEPENDENCY_QUARANTINED' AND "dependencyQuarantinedAt" IS NOT NULL)
    OR ("lifecycleStatus" NOT IN ('DEPENDENCY_QUARANTINED', 'DEPENDENCY_PROMOTING')
      AND "dependencyQuarantinedAt" IS NULL)
  );

CREATE TABLE "ProjectDependencyRepairOperation" (
  "repairId" UUID NOT NULL,
  "action" VARCHAR(32) NOT NULL DEFAULT 'FORCE_FORWARD_STAGED',
  "promotionOperationId" UUID NOT NULL,
  "manifestDigest" VARCHAR(64) NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "authorizationVersion" INTEGER NOT NULL,
  "projectIdentityId" TEXT NOT NULL,
  "projectIdentityGeneration" INTEGER NOT NULL,
  "workspaceOwnerId" TEXT NOT NULL,
  "projectName" TEXT NOT NULL,
  "quarantinedAt" TIMESTAMP(3) NOT NULL,
  "repairJournalCanonicalPath" TEXT NOT NULL,
  "displacementCanonicalRoot" TEXT NOT NULL,
  "repairBindingDigest" VARCHAR(64) NOT NULL,
  "backupPath" TEXT NOT NULL,
  "backupFilename" TEXT NOT NULL,
  "backupDevice" TEXT NOT NULL,
  "backupInode" TEXT NOT NULL,
  "backupSize" BIGINT NOT NULL,
  "backupMtimeNs" TEXT NOT NULL,
  "backupReceiptDigest" VARCHAR(64) NOT NULL,
  "backupFingerprintDigest" VARCHAR(64) NOT NULL,
  "backupLockMarkerPath" TEXT NOT NULL,
  "backupLockMarkerDigest" VARCHAR(64) NOT NULL,
  "backupLockOwned" BOOLEAN NOT NULL,
  "movePlanDigest" VARCHAR(64) NOT NULL,
  "cleanupPlanDigest" VARCHAR(64),
  "status" VARCHAR(16) NOT NULL DEFAULT 'PROMOTING',
  "phase" VARCHAR(24) NOT NULL DEFAULT 'GO_BIT',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "allNewAt" TIMESTAMP(3),
  "appliedAt" TIMESTAMP(3),
  "evidenceCleanedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProjectDependencyRepairOperation_pkey" PRIMARY KEY ("repairId"),
  CONSTRAINT "ProjectDependencyRepairOperation_action_check"
    CHECK ("action" = 'FORCE_FORWARD_STAGED'),
  CONSTRAINT "ProjectDependencyRepairOperation_identifiers_check"
    CHECK (
      length("actorUserId") BETWEEN 1 AND 255
      AND length("sessionId") BETWEEN 1 AND 255
      AND "authorizationVersion" > 0
      AND length("projectIdentityId") BETWEEN 1 AND 255
      AND "projectIdentityGeneration" > 0
      AND length("workspaceOwnerId") BETWEEN 1 AND 255
      AND length("projectName") BETWEEN 1 AND 255
      AND "projectName" !~ '[/\\]'
    ),
  CONSTRAINT "ProjectDependencyRepairOperation_digest_check"
    CHECK (
      "manifestDigest" ~ '^[0-9a-f]{64}$'
      AND "repairBindingDigest" ~ '^[0-9a-f]{64}$'
      AND "backupReceiptDigest" ~ '^[0-9a-f]{64}$'
      AND "backupFingerprintDigest" ~ '^[0-9a-f]{64}$'
      AND "backupLockMarkerDigest" ~ '^[0-9a-f]{64}$'
      AND "movePlanDigest" ~ '^[0-9a-f]{64}$'
      AND ("cleanupPlanDigest" IS NULL OR "cleanupPlanDigest" ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT "ProjectDependencyRepairOperation_paths_check"
    CHECK (
      left("repairJournalCanonicalPath", 1) = '/'
      AND left("displacementCanonicalRoot", 1) = '/'
      AND left("backupPath", 1) = '/'
      AND "backupLockMarkerPath" = "backupPath" || '.locked'
      AND length("repairJournalCanonicalPath") BETWEEN 2 AND 4096
      AND length("displacementCanonicalRoot") BETWEEN 2 AND 4096
      AND length("backupPath") BETWEEN 2 AND 4096
      AND length("backupFilename") BETWEEN 1 AND 255
    ),
  CONSTRAINT "ProjectDependencyRepairOperation_backup_check"
    CHECK (
      length("backupDevice") BETWEEN 1 AND 128
      AND length("backupInode") BETWEEN 1 AND 128
      AND "backupSize" > 0
      AND "backupMtimeNs" ~ '^[0-9]{1,32}$'
    ),
  CONSTRAINT "ProjectDependencyRepairOperation_state_check"
    CHECK (
      ("status" = 'PROMOTING' AND "phase" IN ('GO_BIT', 'ALL_NEW', 'APPLIED')
        AND "cleanupPlanDigest" IS NULL AND "completedAt" IS NULL)
      OR ("status" = 'PROMOTING' AND "phase" = 'EVIDENCE_CLEAN'
        AND "cleanupPlanDigest" IS NOT NULL AND "completedAt" IS NULL)
      OR ("status" = 'APPLIED' AND "phase" = 'COMPLETE'
        AND "cleanupPlanDigest" IS NOT NULL AND "completedAt" IS NOT NULL)
    ),
  CONSTRAINT "ProjectDependencyRepairOperation_timestamp_check"
    CHECK (
      "startedAt" >= "quarantinedAt"
      AND "updatedAt" >= "createdAt"
      AND ("allNewAt" IS NULL OR "allNewAt" >= "startedAt")
      AND ("appliedAt" IS NULL OR ("allNewAt" IS NOT NULL AND "appliedAt" >= "allNewAt"))
      AND ("evidenceCleanedAt" IS NULL OR ("appliedAt" IS NOT NULL AND "evidenceCleanedAt" >= "appliedAt"))
      AND ("completedAt" IS NULL OR ("evidenceCleanedAt" IS NOT NULL AND "completedAt" >= "evidenceCleanedAt"))
    )
);

ALTER TABLE "ProjectDependencyRepairOperation"
  ADD CONSTRAINT "ProjectDependencyRepairOperation_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ProjectDependencyRepairOperation_workspaceOwnerId_fkey"
  FOREIGN KEY ("workspaceOwnerId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ProjectDependencyRepairOperation_projectIdentityId_fkey"
  FOREIGN KEY ("projectIdentityId") REFERENCES "ProjectIdentity"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE UNIQUE INDEX "ProjectDependencyRepairOperation_promotionOperationId_key"
  ON "ProjectDependencyRepairOperation"("promotionOperationId");
CREATE INDEX "ProjectDependencyRepairOperation_identity_generation_status_idx"
  ON "ProjectDependencyRepairOperation"("projectIdentityId", "projectIdentityGeneration", "status");
CREATE INDEX "ProjectDependencyRepairOperation_owner_project_status_idx"
  ON "ProjectDependencyRepairOperation"("workspaceOwnerId", "projectName", "status");
CREATE INDEX "ProjectDependencyRepairOperation_status_updatedAt_idx"
  ON "ProjectDependencyRepairOperation"("status", "updatedAt");

CREATE FUNCTION "attest_project_dependency_repair_operation"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor_row "User"%ROWTYPE;
  session_snapshot TEXT;
  identity_row "ProjectIdentity"%ROWTYPE;
  decision_row "ProjectDependencyPromotionDecision"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PROMOTING' OR NEW."phase" <> 'GO_BIT'
       OR NEW."allNewAt" IS NOT NULL OR NEW."appliedAt" IS NOT NULL
       OR NEW."evidenceCleanedAt" IS NOT NULL OR NEW."completedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Project dependency repair must start at its go-bit';
    END IF;
    SELECT * INTO actor_row FROM "User" WHERE "id" = NEW."actorUserId" FOR SHARE;
    IF NOT FOUND
       OR actor_row."role"::TEXT IS DISTINCT FROM 'OWNER'
       OR actor_row."accountStatus"::TEXT IS DISTINCT FROM 'ACTIVE'
       OR actor_row."isActive" IS DISTINCT FROM TRUE
       OR actor_row."authorizationVersion" IS DISTINCT FROM NEW."authorizationVersion" THEN
      RAISE EXCEPTION 'Project dependency repair Owner snapshot is not active';
    END IF;
    IF NEW."actorUserId" IS DISTINCT FROM NEW."workspaceOwnerId" THEN
      RAISE EXCEPTION 'Project dependency repair Owner must own the exact workspace';
    END IF;
    SELECT "id" INTO session_snapshot FROM "Session"
    WHERE "id" = NEW."sessionId"
      AND "userId" = NEW."actorUserId"
      AND "expiresAt" > clock_timestamp()
    FOR SHARE;
    IF session_snapshot IS NULL THEN
      RAISE EXCEPTION 'Project dependency repair Session snapshot is not active';
    END IF;
    SELECT * INTO identity_row FROM "ProjectIdentity"
    WHERE "id" = NEW."projectIdentityId" FOR SHARE;
    IF NOT FOUND
       OR identity_row."lifecycleStatus" IS DISTINCT FROM 'DEPENDENCY_PROMOTING'
       OR identity_row."dependencyQuarantinedAt" IS DISTINCT FROM NEW."quarantinedAt"
       OR identity_row."workspaceOwnerId" IS DISTINCT FROM NEW."workspaceOwnerId"
       OR identity_row."projectName" IS DISTINCT FROM NEW."projectName"
       OR identity_row."generation" IS DISTINCT FROM NEW."projectIdentityGeneration" THEN
      RAISE EXCEPTION 'Project dependency repair lost its exact Project identity';
    END IF;
    SELECT * INTO decision_row FROM "ProjectDependencyPromotionDecision"
    WHERE "operationId" = NEW."promotionOperationId" FOR SHARE;
    IF NOT FOUND
       OR decision_row."manifestDigest" IS DISTINCT FROM NEW."manifestDigest"
       OR decision_row."projectIdentityId" IS DISTINCT FROM NEW."projectIdentityId"
       OR decision_row."projectIdentityGeneration" IS DISTINCT FROM NEW."projectIdentityGeneration"
       OR decision_row."workspaceOwnerId" IS DISTINCT FROM NEW."workspaceOwnerId"
       OR decision_row."projectName" IS DISTINCT FROM NEW."projectName"
       OR decision_row."status" IS DISTINCT FROM 'AUTHORIZED' THEN
      RAISE EXCEPTION 'Project dependency repair lost its original promotion decision';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."repairId" IS DISTINCT FROM OLD."repairId"
     OR NEW."action" IS DISTINCT FROM OLD."action"
     OR NEW."promotionOperationId" IS DISTINCT FROM OLD."promotionOperationId"
     OR NEW."manifestDigest" IS DISTINCT FROM OLD."manifestDigest"
     OR NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId"
     OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
     OR NEW."authorizationVersion" IS DISTINCT FROM OLD."authorizationVersion"
     OR NEW."projectIdentityId" IS DISTINCT FROM OLD."projectIdentityId"
     OR NEW."projectIdentityGeneration" IS DISTINCT FROM OLD."projectIdentityGeneration"
     OR NEW."workspaceOwnerId" IS DISTINCT FROM OLD."workspaceOwnerId"
     OR NEW."projectName" IS DISTINCT FROM OLD."projectName"
     OR NEW."quarantinedAt" IS DISTINCT FROM OLD."quarantinedAt"
     OR NEW."repairJournalCanonicalPath" IS DISTINCT FROM OLD."repairJournalCanonicalPath"
     OR NEW."displacementCanonicalRoot" IS DISTINCT FROM OLD."displacementCanonicalRoot"
     OR NEW."repairBindingDigest" IS DISTINCT FROM OLD."repairBindingDigest"
     OR NEW."backupPath" IS DISTINCT FROM OLD."backupPath"
     OR NEW."backupFilename" IS DISTINCT FROM OLD."backupFilename"
     OR NEW."backupDevice" IS DISTINCT FROM OLD."backupDevice"
     OR NEW."backupInode" IS DISTINCT FROM OLD."backupInode"
     OR NEW."backupSize" IS DISTINCT FROM OLD."backupSize"
     OR NEW."backupMtimeNs" IS DISTINCT FROM OLD."backupMtimeNs"
     OR NEW."backupReceiptDigest" IS DISTINCT FROM OLD."backupReceiptDigest"
     OR NEW."backupFingerprintDigest" IS DISTINCT FROM OLD."backupFingerprintDigest"
     OR NEW."backupLockMarkerPath" IS DISTINCT FROM OLD."backupLockMarkerPath"
     OR NEW."backupLockMarkerDigest" IS DISTINCT FROM OLD."backupLockMarkerDigest"
     OR NEW."backupLockOwned" IS DISTINCT FROM OLD."backupLockOwned"
     OR NEW."movePlanDigest" IS DISTINCT FROM OLD."movePlanDigest"
     OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Project dependency repair immutable snapshot changed';
  END IF;
  IF NOT (
    (OLD."phase" IN ('GO_BIT', 'ALL_NEW')
      AND NEW."cleanupPlanDigest" IS NULL AND OLD."cleanupPlanDigest" IS NULL)
    OR (OLD."phase" = 'APPLIED'
      AND OLD."cleanupPlanDigest" IS NULL AND NEW."cleanupPlanDigest" IS NOT NULL)
    OR (OLD."phase" = 'EVIDENCE_CLEAN'
      AND NEW."cleanupPlanDigest" IS NOT DISTINCT FROM OLD."cleanupPlanDigest")
  ) THEN
    RAISE EXCEPTION 'Project dependency repair cleanup authorization changed outside its go-bit';
  END IF;
  IF NOT (
    (OLD."status" = 'PROMOTING' AND OLD."phase" = 'GO_BIT'
      AND NEW."status" = 'PROMOTING' AND NEW."phase" = 'ALL_NEW')
    OR (OLD."status" = 'PROMOTING' AND OLD."phase" = 'ALL_NEW'
      AND NEW."status" = 'PROMOTING' AND NEW."phase" = 'APPLIED')
    OR (OLD."status" = 'PROMOTING' AND OLD."phase" = 'APPLIED'
      AND NEW."status" = 'PROMOTING' AND NEW."phase" = 'EVIDENCE_CLEAN')
    OR (OLD."status" = 'PROMOTING' AND OLD."phase" = 'EVIDENCE_CLEAN'
      AND NEW."status" = 'APPLIED' AND NEW."phase" = 'COMPLETE')
  ) THEN
    RAISE EXCEPTION 'Project dependency repair phase transition is not adjacent and monotonic';
  END IF;
  IF NEW."updatedAt" < OLD."updatedAt"
     OR (NEW."allNewAt" IS NOT NULL AND NEW."updatedAt" < NEW."allNewAt")
     OR (NEW."appliedAt" IS NOT NULL AND NEW."updatedAt" < NEW."appliedAt")
     OR (NEW."evidenceCleanedAt" IS NOT NULL AND NEW."updatedAt" < NEW."evidenceCleanedAt")
     OR (NEW."completedAt" IS NOT NULL AND NEW."updatedAt" < NEW."completedAt") THEN
    RAISE EXCEPTION 'Project dependency repair update time is not monotonic';
  END IF;
  IF (OLD."phase" = 'GO_BIT' AND (
        OLD."allNewAt" IS NOT NULL OR OLD."appliedAt" IS NOT NULL
        OR OLD."evidenceCleanedAt" IS NOT NULL OR OLD."completedAt" IS NOT NULL
        OR NEW."allNewAt" IS NULL OR NEW."appliedAt" IS NOT NULL
        OR NEW."evidenceCleanedAt" IS NOT NULL OR NEW."completedAt" IS NOT NULL
      ))
     OR (OLD."phase" = 'ALL_NEW' AND (
        OLD."allNewAt" IS NULL OR OLD."appliedAt" IS NOT NULL
        OR OLD."evidenceCleanedAt" IS NOT NULL OR OLD."completedAt" IS NOT NULL
        OR NEW."allNewAt" IS DISTINCT FROM OLD."allNewAt" OR NEW."appliedAt" IS NULL
        OR NEW."evidenceCleanedAt" IS NOT NULL OR NEW."completedAt" IS NOT NULL
      ))
     OR (OLD."phase" = 'APPLIED' AND (
        OLD."allNewAt" IS NULL OR OLD."appliedAt" IS NULL
        OR OLD."evidenceCleanedAt" IS NOT NULL OR OLD."completedAt" IS NOT NULL
        OR NEW."allNewAt" IS DISTINCT FROM OLD."allNewAt"
        OR NEW."appliedAt" IS DISTINCT FROM OLD."appliedAt"
        OR NEW."evidenceCleanedAt" IS NULL OR NEW."completedAt" IS NOT NULL
      ))
     OR (OLD."phase" = 'EVIDENCE_CLEAN' AND (
        OLD."allNewAt" IS NULL OR OLD."appliedAt" IS NULL
        OR OLD."evidenceCleanedAt" IS NULL OR OLD."completedAt" IS NOT NULL
        OR NEW."allNewAt" IS DISTINCT FROM OLD."allNewAt"
        OR NEW."appliedAt" IS DISTINCT FROM OLD."appliedAt"
        OR NEW."evidenceCleanedAt" IS DISTINCT FROM OLD."evidenceCleanedAt"
        OR NEW."completedAt" IS NULL
      )) THEN
    RAISE EXCEPTION 'Project dependency repair phase timestamps are inconsistent or mutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectDependencyRepairOperation_attest"
BEFORE INSERT OR UPDATE ON "ProjectDependencyRepairOperation"
FOR EACH ROW EXECUTE FUNCTION "attest_project_dependency_repair_operation"();

CREATE FUNCTION "protect_live_project_dependency_repair_deletion"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'APPLIED' OR OLD."phase" <> 'COMPLETE' THEN
    RAISE EXCEPTION 'A live Project dependency repair receipt cannot be deleted';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "ProjectDependencyRepairOperation_protect_delete"
BEFORE DELETE ON "ProjectDependencyRepairOperation"
FOR EACH ROW EXECUTE FUNCTION "protect_live_project_dependency_repair_deletion"();

COMMIT;
