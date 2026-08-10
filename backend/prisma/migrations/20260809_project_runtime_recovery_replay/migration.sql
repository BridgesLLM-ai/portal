BEGIN;

-- Runtime status is observed state, not user deployment intent. Keep a
-- separate ProjectIdentity-scoped generation so processStatus reconciliation
-- during Portal startup cannot invalidate or accidentally authorize a replay.
CREATE TABLE "ProjectDeploymentLifecycleRevision" (
  "projectIdentityId" TEXT NOT NULL,
  "revision" BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProjectDeploymentLifecycleRevision_pkey"
    PRIMARY KEY ("projectIdentityId"),
  CONSTRAINT "ProjectDeploymentLifecycleRevision_revision_check"
    CHECK ("revision" >= 0),
  CONSTRAINT "ProjectDeploymentLifecycleRevision_projectIdentityId_fkey"
    FOREIGN KEY ("projectIdentityId") REFERENCES "ProjectIdentity"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ProjectRuntimeRecoveryOperation" (
  "id" TEXT NOT NULL,
  "projectIdentityId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "projectIdentityGeneration" INTEGER NOT NULL,
  "action" VARCHAR(16) NOT NULL,
  "expectedAppId" TEXT,
  "expectedDeploymentRevision" BIGINT NOT NULL,
  "claimedDeploymentRevision" BIGINT,
  "expectedFullstack" BOOLEAN,
  "sourceDigest" VARCHAR(64),
  "proofSecretHash" VARCHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'ISSUED',
  "result" JSONB,
  "failureCode" VARCHAR(64),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "claimedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProjectRuntimeRecoveryOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectRuntimeRecoveryOperation_projectIdentityId_fkey"
    FOREIGN KEY ("projectIdentityId")
    REFERENCES "ProjectDeploymentLifecycleRevision"("projectIdentityId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectRuntimeRecoveryOperation_id_check"
    CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "ProjectRuntimeRecoveryOperation_owner_check"
    CHECK (length("ownerUserId") BETWEEN 1 AND 255),
  CONSTRAINT "ProjectRuntimeRecoveryOperation_generation_check"
    CHECK ("projectIdentityGeneration" > 0),
  CONSTRAINT "ProjectRuntimeRecoveryOperation_action_check"
    CHECK ("action" IN ('deploy', 'start', 'restart')),
  CONSTRAINT "ProjectRuntimeRecoveryOperation_action_snapshot_check"
    CHECK (
      (
        "action" = 'deploy'
        AND "expectedFullstack" IS TRUE
        AND "sourceDigest" IS NOT NULL
      )
      OR (
        "action" IN ('start', 'restart')
        AND "expectedAppId" IS NOT NULL
        AND "expectedFullstack" IS TRUE
      )
    ),
  CONSTRAINT "ProjectRuntimeRecoveryOperation_revision_check"
    CHECK (
      "expectedDeploymentRevision" >= 0
      AND (
        "claimedDeploymentRevision" IS NULL
        OR "claimedDeploymentRevision" = "expectedDeploymentRevision" + 1
      )
    ),
  CONSTRAINT "ProjectRuntimeRecoveryOperation_source_digest_check"
    CHECK (
      "sourceDigest" IS NULL
      OR (
        "expectedFullstack" IS NOT NULL
        AND "sourceDigest" ~ '^[0-9a-f]{64}$'
      )
    ),
  CONSTRAINT "ProjectRuntimeRecoveryOperation_proof_hash_check"
    CHECK ("proofSecretHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ProjectRuntimeRecoveryOperation_expiry_check"
    CHECK (
      "expiresAt" >= "createdAt" + INTERVAL '1 minute'
      AND "expiresAt" <= "createdAt" + INTERVAL '30 minutes'
    ),
  CONSTRAINT "ProjectRuntimeRecoveryOperation_timestamp_order_check"
    CHECK (
      "updatedAt" >= "createdAt"
      AND (
        "claimedAt" IS NULL
        OR ("claimedAt" >= "createdAt" AND "claimedAt" <= "expiresAt")
      )
      AND ("completedAt" IS NULL OR "completedAt" >= "claimedAt")
      AND ("failedAt" IS NULL OR "failedAt" >= "claimedAt")
    ),
  CONSTRAINT "ProjectRuntimeRecoveryOperation_status_check"
    CHECK ("status" IN ('ISSUED', 'RUNNING', 'COMPLETED', 'FAILED')),
  CONSTRAINT "ProjectRuntimeRecoveryOperation_failure_code_check"
    CHECK ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CONSTRAINT "ProjectRuntimeRecoveryOperation_result_bound_check"
    CHECK ("result" IS NULL OR octet_length("result"::text) <= 32768),
  CONSTRAINT "ProjectRuntimeRecoveryOperation_result_shape_check"
    CHECK (
      "result" IS NULL
      OR COALESCE((
        jsonb_typeof("result") = 'object'
        AND ("result" - 'statusCode' - 'body') = '{}'::jsonb
        AND "result"->'statusCode' IN ('200'::jsonb, '201'::jsonb)
        AND jsonb_typeof("result"->'body') = 'object'
        AND (
          ("result"->'body')
          - 'success'
          - 'action'
          - 'projectIdentityId'
          - 'projectIdentityGeneration'
          - 'appId'
          - 'deploymentRevision'
        ) = '{}'::jsonb
        AND "result"->'body'->'success' = 'true'::jsonb
        AND "result"->'body'->>'action' = "action"
        AND "result"->'body'->>'projectIdentityId' = "projectIdentityId"
        AND "result"->'body'->>'projectIdentityGeneration' ~ '^[1-9][0-9]*$'
        AND ("result"->'body'->>'projectIdentityGeneration')::INTEGER
          = "projectIdentityGeneration"
        AND length("result"->'body'->>'appId') BETWEEN 1 AND 255
        AND "result"->'body'->>'deploymentRevision' = "claimedDeploymentRevision"::TEXT
      ), FALSE)
    ),
  CONSTRAINT "ProjectRuntimeRecoveryOperation_state_shape_check"
    CHECK (
      (
        "status" = 'ISSUED'
        AND "claimedDeploymentRevision" IS NULL
        AND "claimedAt" IS NULL
        AND "completedAt" IS NULL
        AND "failedAt" IS NULL
        AND "result" IS NULL
        AND "failureCode" IS NULL
      )
      OR (
        "status" = 'RUNNING'
        AND "claimedDeploymentRevision" = "expectedDeploymentRevision" + 1
        AND "claimedAt" IS NOT NULL
        AND "completedAt" IS NULL
        AND "failedAt" IS NULL
        AND "result" IS NULL
        AND "failureCode" IS NULL
      )
      OR (
        "status" = 'COMPLETED'
        AND "claimedDeploymentRevision" = "expectedDeploymentRevision" + 1
        AND "claimedAt" IS NOT NULL
        AND "completedAt" IS NOT NULL
        AND "failedAt" IS NULL
        AND "result" IS NOT NULL
        AND jsonb_typeof("result") = 'object'
        AND "failureCode" IS NULL
      )
      OR (
        "status" = 'FAILED'
        AND "claimedDeploymentRevision" = "expectedDeploymentRevision" + 1
        AND "claimedAt" IS NOT NULL
        AND "completedAt" IS NULL
        AND "failedAt" IS NOT NULL
        AND "result" IS NULL
        AND "failureCode" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "ProjectRuntimeRecoveryOperation_proofSecretHash_key"
  ON "ProjectRuntimeRecoveryOperation"("proofSecretHash");
CREATE INDEX "ProjectRuntimeRecoveryOperation_projectIdentityId_status_idx"
  ON "ProjectRuntimeRecoveryOperation"("projectIdentityId", "status");
CREATE INDEX "ProjectRuntimeRecoveryOperation_expiresAt_idx"
  ON "ProjectRuntimeRecoveryOperation"("expiresAt");

-- Revisions may only move forward one step. This applies equally to ordinary
-- user lifecycle admission and an ISSUED recovery receipt claim.
CREATE FUNCTION "advance_project_deployment_lifecycle_revision"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."revision" <> 0 OR NOT EXISTS (
      SELECT 1 FROM "ProjectIdentity"
      WHERE "id" = NEW."projectIdentityId"
        AND "lifecycleStatus" = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'Project deployment lifecycle revision is not active';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."projectIdentityId" IS DISTINCT FROM OLD."projectIdentityId"
     OR NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'Project deployment lifecycle revision must advance exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectDeploymentLifecycleRevision_advance_once"
BEFORE INSERT OR UPDATE ON "ProjectDeploymentLifecycleRevision"
FOR EACH ROW EXECUTE FUNCTION "advance_project_deployment_lifecycle_revision"();

-- Snapshot provenance is immutable. Status can only move ISSUED -> RUNNING ->
-- one terminal state; a terminal receipt is therefore an exact durable replay.
CREATE FUNCTION "attest_project_runtime_recovery_operation"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_revision BIGINT;
  associated_app_count BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ISSUED' THEN
      RAISE EXCEPTION 'Project runtime recovery operation must start issued';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "ProjectIdentity"
      WHERE "id" = NEW."projectIdentityId"
        AND "workspaceOwnerId" = NEW."ownerUserId"
        AND "generation" = NEW."projectIdentityGeneration"
        AND "lifecycleStatus" = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'Project runtime recovery identity snapshot is not active';
    END IF;

    SELECT "revision" INTO current_revision
    FROM "ProjectDeploymentLifecycleRevision"
    WHERE "projectIdentityId" = NEW."projectIdentityId";
    IF current_revision IS NULL OR current_revision <> NEW."expectedDeploymentRevision" THEN
      RAISE EXCEPTION 'Project runtime recovery deployment revision is stale';
    END IF;

    IF (
      NEW."expectedAppId" IS NULL
      AND EXISTS (
        SELECT 1 FROM "App"
        WHERE "projectIdentityId" = NEW."projectIdentityId"
      )
    ) OR (
      NEW."expectedAppId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "App"
        WHERE "id" = NEW."expectedAppId"
          AND "projectIdentityId" = NEW."projectIdentityId"
          AND "userId" = NEW."ownerUserId"
      )
    ) THEN
      RAISE EXCEPTION 'Project runtime recovery App snapshot is stale';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."projectIdentityId" IS DISTINCT FROM OLD."projectIdentityId"
     OR NEW."ownerUserId" IS DISTINCT FROM OLD."ownerUserId"
     OR NEW."projectIdentityGeneration" IS DISTINCT FROM OLD."projectIdentityGeneration"
     OR NEW."action" IS DISTINCT FROM OLD."action"
     OR NEW."expectedAppId" IS DISTINCT FROM OLD."expectedAppId"
     OR NEW."expectedDeploymentRevision" IS DISTINCT FROM OLD."expectedDeploymentRevision"
     OR NEW."expectedFullstack" IS DISTINCT FROM OLD."expectedFullstack"
     OR NEW."sourceDigest" IS DISTINCT FROM OLD."sourceDigest"
     OR NEW."proofSecretHash" IS DISTINCT FROM OLD."proofSecretHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Project runtime recovery snapshot is immutable';
  END IF;

  IF OLD."status" = 'ISSUED' AND NEW."status" = 'RUNNING' THEN
    IF clock_timestamp() >= NEW."expiresAt" THEN
      RAISE EXCEPTION 'Project runtime recovery operation expired before claim';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "ProjectIdentity"
      WHERE "id" = NEW."projectIdentityId"
        AND "workspaceOwnerId" = NEW."ownerUserId"
        AND "generation" = NEW."projectIdentityGeneration"
        AND "lifecycleStatus" = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'Project runtime recovery identity changed before claim';
    END IF;
    IF (
      NEW."expectedAppId" IS NULL
      AND EXISTS (
        SELECT 1 FROM "App"
        WHERE "projectIdentityId" = NEW."projectIdentityId"
      )
    ) OR (
      NEW."expectedAppId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "App"
        WHERE "id" = NEW."expectedAppId"
          AND "projectIdentityId" = NEW."projectIdentityId"
          AND "userId" = NEW."ownerUserId"
      )
    ) THEN
      RAISE EXCEPTION 'Project runtime recovery App changed before claim';
    END IF;
    SELECT "revision" INTO current_revision
    FROM "ProjectDeploymentLifecycleRevision"
    WHERE "projectIdentityId" = NEW."projectIdentityId";
    IF current_revision <> NEW."claimedDeploymentRevision" THEN
      RAISE EXCEPTION 'Project runtime recovery claim is not revision-attested';
    END IF;
  ELSIF OLD."status" = 'RUNNING' AND NEW."status" IN ('COMPLETED', 'FAILED') THEN
    IF NEW."claimedDeploymentRevision" IS DISTINCT FROM OLD."claimedDeploymentRevision"
       OR NEW."claimedAt" IS DISTINCT FROM OLD."claimedAt" THEN
      RAISE EXCEPTION 'Project runtime recovery claim provenance is immutable';
    END IF;
    IF NEW."status" = 'COMPLETED' THEN
      SELECT COUNT(*) INTO associated_app_count
      FROM "App"
      WHERE "projectIdentityId" = NEW."projectIdentityId";
      IF associated_app_count <> 1
         OR NOT EXISTS (
           SELECT 1 FROM "App"
           WHERE "id" = NEW."result"->'body'->>'appId'
             AND "projectIdentityId" = NEW."projectIdentityId"
             AND "userId" = NEW."ownerUserId"
         )
         OR (
           NEW."expectedAppId" IS NOT NULL
           AND NEW."result"->'body'->>'appId' IS DISTINCT FROM NEW."expectedAppId"
         ) THEN
        RAISE EXCEPTION 'Project runtime recovery completion App is not attested';
      END IF;
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid Project runtime recovery state transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectRuntimeRecoveryOperation_attest"
BEFORE INSERT OR UPDATE ON "ProjectRuntimeRecoveryOperation"
FOR EACH ROW EXECUTE FUNCTION "attest_project_runtime_recovery_operation"();

COMMIT;
