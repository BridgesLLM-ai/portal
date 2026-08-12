BEGIN;

-- This ledger is the durable decision point between a completed dependency
-- staging job and mutation of the live Project tree. Snapshot columns have no
-- mutable payload. Actor/User and ProjectIdentity RESTRICT relations retain
-- proof; Session stays a scalar snapshot so logout remains possible.
CREATE TABLE "ProjectDependencyPromotionDecision" (
  "operationId" UUID NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "authorizationVersion" INTEGER NOT NULL,
  "projectIdentityId" TEXT NOT NULL,
  "projectIdentityGeneration" INTEGER NOT NULL,
  "workspaceOwnerId" TEXT NOT NULL,
  "projectName" TEXT NOT NULL,
  "operationParentCanonicalRoot" TEXT NOT NULL,
  "operationParentDevice" TEXT NOT NULL,
  "operationParentInode" TEXT NOT NULL,
  "operationParentBirthtimeNs" TEXT NOT NULL,
  "operationParentMode" INTEGER NOT NULL,
  "operationParentUid" INTEGER NOT NULL,
  "operationParentGid" INTEGER NOT NULL,
  "destinationCanonicalRoot" TEXT NOT NULL,
  "destinationRootDevice" TEXT NOT NULL,
  "destinationRootInode" TEXT NOT NULL,
  "destinationRootBirthtimeNs" TEXT NOT NULL,
  "manifestDigest" VARCHAR(64) NOT NULL,
  "manifest" JSONB NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'AUTHORIZED',
  "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProjectDependencyPromotionDecision_pkey" PRIMARY KEY ("operationId"),
  CONSTRAINT "ProjectDependencyPromotionDecision_operation_id_check"
    CHECK ("operationId"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "ProjectDependencyPromotionDecision_authorization_version_check"
    CHECK ("authorizationVersion" > 0),
  CONSTRAINT "ProjectDependencyPromotionDecision_project_generation_check"
    CHECK ("projectIdentityGeneration" > 0),
  CONSTRAINT "ProjectDependencyPromotionDecision_identifier_check"
    CHECK (
      length("actorUserId") BETWEEN 1 AND 255
      AND length("sessionId") BETWEEN 1 AND 255
      AND length("projectIdentityId") BETWEEN 1 AND 255
      AND length("workspaceOwnerId") BETWEEN 1 AND 255
      AND length("projectName") BETWEEN 1 AND 255
      AND "projectName" !~ '[/\\]'
      AND length("operationParentCanonicalRoot") BETWEEN 1 AND 4096
      AND left("operationParentCanonicalRoot", 1) = '/'
      AND length("operationParentDevice") BETWEEN 1 AND 128
      AND length("operationParentInode") BETWEEN 1 AND 128
      AND length("operationParentBirthtimeNs") BETWEEN 1 AND 128
      AND "operationParentMode" BETWEEN 0 AND 511
      AND "operationParentUid" >= 0
      AND "operationParentGid" >= 0
      AND length("destinationCanonicalRoot") BETWEEN 1 AND 4096
      AND left("destinationCanonicalRoot", 1) = '/'
      AND length("destinationRootDevice") BETWEEN 1 AND 128
      AND length("destinationRootInode") BETWEEN 1 AND 128
      AND length("destinationRootBirthtimeNs") BETWEEN 1 AND 128
    ),
  CONSTRAINT "ProjectDependencyPromotionDecision_path_binding_check"
    CHECK (
      "destinationCanonicalRoot" = "operationParentCanonicalRoot" || '/' || "projectName"
      AND right("operationParentCanonicalRoot", length("workspaceOwnerId") + 1)
        = '/' || "workspaceOwnerId"
    ),
  CONSTRAINT "ProjectDependencyPromotionDecision_manifest_digest_check"
    CHECK ("manifestDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ProjectDependencyPromotionDecision_manifest_check"
    CHECK (
      jsonb_typeof("manifest") = 'object'
      AND octet_length("manifest"::TEXT) BETWEEN 1 AND 131072
      AND "manifest"->>'manifestDigest' = "manifestDigest"
      AND "manifest"->>'operationId' = "operationId"::TEXT
      AND "manifest"->>'projectIdentityId' = "projectIdentityId"
      AND ("manifest"->>'projectIdentityGeneration')::INTEGER = "projectIdentityGeneration"
      AND "manifest"->>'workspaceOwnerId' = "workspaceOwnerId"
      AND "manifest"->>'projectName' = "projectName"
      AND "manifest"->>'operationParentCanonicalRoot' = "operationParentCanonicalRoot"
      AND "manifest"->>'destinationCanonicalRoot' = "destinationCanonicalRoot"
      AND jsonb_typeof("manifest"->'entries') = 'array'
      AND jsonb_array_length("manifest"->'entries') BETWEEN 1 AND 16
    ),
  CONSTRAINT "ProjectDependencyPromotionDecision_status_check"
    CHECK ("status" IN ('AUTHORIZED', 'APPLIED')),
  CONSTRAINT "ProjectDependencyPromotionDecision_state_check"
    CHECK (
      ("status" = 'AUTHORIZED' AND "appliedAt" IS NULL)
      OR
      ("status" = 'APPLIED' AND "appliedAt" IS NOT NULL)
    ),
  CONSTRAINT "ProjectDependencyPromotionDecision_timestamp_check"
    CHECK (
      "authorizedAt" >= "createdAt"
      AND "updatedAt" >= "createdAt"
      AND ("appliedAt" IS NULL OR "appliedAt" >= "authorizedAt")
    )
);

ALTER TABLE "ProjectDependencyPromotionDecision"
  ADD CONSTRAINT "ProjectDependencyPromotionDecision_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ProjectDependencyPromotionDecision_workspaceOwnerId_fkey"
  FOREIGN KEY ("workspaceOwnerId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ProjectDependencyPromotionDecision_projectIdentityId_fkey"
  FOREIGN KEY ("projectIdentityId") REFERENCES "ProjectIdentity"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A destination remains fenced while either its AUTHORIZED decision or its
-- APPLIED cleanup receipt exists. Recovery deletes the APPLIED row only after
-- its same-filesystem evidence is durably gone.
CREATE UNIQUE INDEX "ProjectDependencyPromotionDecision_destination_key"
  ON "ProjectDependencyPromotionDecision"("destinationCanonicalRoot");
CREATE INDEX "ProjectDependencyPromotionDecision_owner_project_status_idx"
  ON "ProjectDependencyPromotionDecision"("workspaceOwnerId", "projectName", "status");
CREATE INDEX "ProjectDependencyPromotionDecision_identity_generation_idx"
  ON "ProjectDependencyPromotionDecision"("projectIdentityId", "projectIdentityGeneration");
CREATE INDEX "ProjectDependencyPromotionDecision_status_appliedAt_idx"
  ON "ProjectDependencyPromotionDecision"("status", "appliedAt");

CREATE FUNCTION "attest_project_dependency_promotion_decision"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor_authorization_version INTEGER;
  actor_active BOOLEAN;
  actor_account_status TEXT;
  actor_role TEXT;
  actor_sandbox_enabled BOOLEAN;
  primary_owner_id TEXT;
  session_snapshot_id TEXT;
  identity_row "ProjectIdentity"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'AUTHORIZED' OR NEW."appliedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Project dependency promotion decision must start authorized';
    END IF;

    SELECT "authorizationVersion", "isActive", "accountStatus"::TEXT,
           "role"::TEXT, "sandboxEnabled"
      INTO actor_authorization_version, actor_active, actor_account_status,
           actor_role, actor_sandbox_enabled
    FROM "User"
    WHERE "id" = NEW."actorUserId"
    FOR SHARE;
    IF NOT FOUND
       OR actor_active IS DISTINCT FROM TRUE
       OR actor_account_status IS DISTINCT FROM 'ACTIVE'
       OR actor_role NOT IN ('OWNER', 'SUB_ADMIN', 'USER')
       OR actor_authorization_version IS DISTINCT FROM NEW."authorizationVersion" THEN
      RAISE EXCEPTION 'Project dependency promotion actor snapshot is not active';
    END IF;

    IF NEW."workspaceOwnerId" IS DISTINCT FROM NEW."actorUserId" THEN
      IF actor_role NOT IN ('OWNER', 'SUB_ADMIN')
         OR actor_sandbox_enabled IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION 'Project dependency promotion actor is outside the workspace scope';
      END IF;
      SELECT "id" INTO primary_owner_id
      FROM "User"
      WHERE "role" = 'OWNER'
        AND "accountStatus" = 'ACTIVE'
        AND "isActive" = TRUE
      ORDER BY "createdAt" ASC, "id" ASC
      LIMIT 1
      FOR SHARE;
      IF primary_owner_id IS NULL OR primary_owner_id IS DISTINCT FROM NEW."workspaceOwnerId" THEN
        RAISE EXCEPTION 'Project dependency promotion owner is not the active primary owner';
      END IF;
    END IF;

    SELECT "id" INTO session_snapshot_id
    FROM "Session"
    WHERE "id" = NEW."sessionId"
      AND "userId" = NEW."actorUserId"
      AND "expiresAt" > clock_timestamp()
    FOR SHARE;
    IF session_snapshot_id IS NULL THEN
      RAISE EXCEPTION 'Project dependency promotion Session snapshot is not active; sign in again';
    END IF;

    SELECT * INTO identity_row
    FROM "ProjectIdentity"
    WHERE "id" = NEW."projectIdentityId"
    FOR SHARE;
    IF NOT FOUND
       OR identity_row."lifecycleStatus" IS DISTINCT FROM 'DEPENDENCY_PROMOTING'
       OR identity_row."workspaceOwnerId" IS DISTINCT FROM NEW."workspaceOwnerId"
       OR identity_row."projectName" IS DISTINCT FROM NEW."projectName"
       OR identity_row."generation" IS DISTINCT FROM NEW."projectIdentityGeneration"
       OR identity_row."canonicalRoot" IS DISTINCT FROM NEW."destinationCanonicalRoot"
       OR identity_row."rootDevice" IS DISTINCT FROM NEW."destinationRootDevice"
       OR identity_row."rootInode" IS DISTINCT FROM NEW."destinationRootInode"
       OR identity_row."rootBirthtimeNs" IS DISTINCT FROM NEW."destinationRootBirthtimeNs" THEN
      RAISE EXCEPTION 'Project dependency promotion identity snapshot is not active';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."operationId" IS DISTINCT FROM OLD."operationId"
       OR NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId"
       OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
       OR NEW."authorizationVersion" IS DISTINCT FROM OLD."authorizationVersion"
       OR NEW."projectIdentityId" IS DISTINCT FROM OLD."projectIdentityId"
       OR NEW."projectIdentityGeneration" IS DISTINCT FROM OLD."projectIdentityGeneration"
       OR NEW."workspaceOwnerId" IS DISTINCT FROM OLD."workspaceOwnerId"
       OR NEW."projectName" IS DISTINCT FROM OLD."projectName"
       OR NEW."operationParentCanonicalRoot" IS DISTINCT FROM OLD."operationParentCanonicalRoot"
       OR NEW."operationParentDevice" IS DISTINCT FROM OLD."operationParentDevice"
       OR NEW."operationParentInode" IS DISTINCT FROM OLD."operationParentInode"
       OR NEW."operationParentBirthtimeNs" IS DISTINCT FROM OLD."operationParentBirthtimeNs"
       OR NEW."operationParentMode" IS DISTINCT FROM OLD."operationParentMode"
       OR NEW."operationParentUid" IS DISTINCT FROM OLD."operationParentUid"
       OR NEW."operationParentGid" IS DISTINCT FROM OLD."operationParentGid"
       OR NEW."destinationCanonicalRoot" IS DISTINCT FROM OLD."destinationCanonicalRoot"
       OR NEW."destinationRootDevice" IS DISTINCT FROM OLD."destinationRootDevice"
       OR NEW."destinationRootInode" IS DISTINCT FROM OLD."destinationRootInode"
       OR NEW."destinationRootBirthtimeNs" IS DISTINCT FROM OLD."destinationRootBirthtimeNs"
       OR NEW."manifestDigest" IS DISTINCT FROM OLD."manifestDigest"
       OR NEW."manifest" IS DISTINCT FROM OLD."manifest"
       OR NEW."authorizedAt" IS DISTINCT FROM OLD."authorizedAt"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'Project dependency promotion decision snapshot is immutable';
    END IF;
    IF OLD."status" <> 'AUTHORIZED' OR NEW."status" <> 'APPLIED'
       OR OLD."appliedAt" IS NOT NULL OR NEW."appliedAt" IS NULL THEN
      RAISE EXCEPTION 'Invalid Project dependency promotion decision transition';
    END IF;
    SELECT * INTO identity_row
    FROM "ProjectIdentity"
    WHERE "id" = NEW."projectIdentityId"
    FOR SHARE;
    IF NOT FOUND
       OR identity_row."lifecycleStatus" IS DISTINCT FROM 'DEPENDENCY_PROMOTING'
       OR identity_row."workspaceOwnerId" IS DISTINCT FROM NEW."workspaceOwnerId"
       OR identity_row."projectName" IS DISTINCT FROM NEW."projectName"
       OR identity_row."generation" IS DISTINCT FROM NEW."projectIdentityGeneration"
       OR identity_row."canonicalRoot" IS DISTINCT FROM NEW."destinationCanonicalRoot"
       OR identity_row."rootDevice" IS DISTINCT FROM NEW."destinationRootDevice"
       OR identity_row."rootInode" IS DISTINCT FROM NEW."destinationRootInode"
       OR identity_row."rootBirthtimeNs" IS DISTINCT FROM NEW."destinationRootBirthtimeNs" THEN
      RAISE EXCEPTION 'Applied Project dependency promotion lost its exact lifecycle fence';
    END IF;
    RETURN NEW;
  END IF;

  -- An unresolved authorization is permanent evidence and cannot be deleted.
  -- APPLIED receipts are deleted explicitly only after filesystem evidence
  -- cleanup; there is deliberately no cascade or automatic cleanup trigger.
  IF OLD."status" <> 'APPLIED' THEN
    RAISE EXCEPTION 'Authorized Project dependency promotion decision cannot be deleted';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "ProjectDependencyPromotionDecision_attest"
BEFORE INSERT OR UPDATE OR DELETE ON "ProjectDependencyPromotionDecision"
FOR EACH ROW EXECUTE FUNCTION "attest_project_dependency_promotion_decision"();

COMMIT;
