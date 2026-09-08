-- Portal 4.1 durable user retirement authority and authorization-transition integration.
BEGIN;

-- Runtime cleanup provenance participates in User retirement just like the
-- dependency promotion/repair actor ledgers. The FK is intentionally RESTRICT:
-- a missed row must stop User deletion, never disappear as an implicit cascade.
ALTER TABLE "ProjectRuntimeCleanupActor"
  ADD CONSTRAINT "ProjectRuntimeCleanupActor_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "ProjectRuntimeCleanupActor_actorUserId_idx"
  ON "ProjectRuntimeCleanupActor"("actorUserId");

CREATE OR REPLACE FUNCTION "ProjectRuntimeCleanupActor_attest_actor"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor_active BOOLEAN;
  actor_account_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."projectIdentityId" IS DISTINCT FROM OLD."projectIdentityId"
      OR NEW."provider" IS DISTINCT FROM OLD."provider"
      OR NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId"
      OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    THEN
      RAISE EXCEPTION 'Project runtime cleanup actor authority is immutable'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT "isActive", "accountStatus"::TEXT
    INTO actor_active, actor_account_status
    FROM "User"
    WHERE "id" = NEW."actorUserId"
    -- FOR SHARE must conflict with the retirement seal's non-key User update.
    -- FOR KEY SHARE would allow a concurrent cleanup-actor insert to attest the
    -- pre-seal ACTIVE row and commit after the immutable manifest was written.
    FOR SHARE;
  IF NOT FOUND
    OR actor_active IS DISTINCT FROM TRUE
    OR actor_account_status IS DISTINCT FROM 'ACTIVE'
  THEN
    RAISE EXCEPTION 'Project runtime cleanup actor is not active'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectRuntimeCleanupActor_attest_actor_trigger"
BEFORE INSERT OR UPDATE ON "ProjectRuntimeCleanupActor"
FOR EACH ROW EXECUTE FUNCTION "ProjectRuntimeCleanupActor_attest_actor"();

CREATE TABLE "AdminUserRetirement" (
  "id" UUID NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "manifestVersion" INTEGER NOT NULL DEFAULT 1,
  "manifest" JSONB NOT NULL,
  "manifestDigest" TEXT NOT NULL,
  "targetAuthorizationVersion" INTEGER NOT NULL,
  "phase" TEXT NOT NULL DEFAULT 'MANIFESTED',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "leaseTokenHash" TEXT,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorDetail" TEXT,
  "startedAt" TIMESTAMP(3),
  "admissionClosedAt" TIMESTAMP(3),
  "authorizationTransitionId" TEXT,
  "closedAuthorizationVersion" INTEGER,
  "admissionEvidenceDigest" TEXT,
  "externalAbsenceVerifiedAt" TIMESTAMP(3),
  "externalAbsenceDigest" TEXT,
  "databaseCommittedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AdminUserRetirement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdminUserRetirement_manifest_version_check"
    CHECK ("manifestVersion" = 1),
  CONSTRAINT "AdminUserRetirement_manifest_digest_check"
    CHECK ("manifestDigest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "AdminUserRetirement_authorization_version_check"
    CHECK ("targetAuthorizationVersion" >= 1),
  CONSTRAINT "AdminUserRetirement_attempts_check"
    CHECK ("attempts" >= 0),
  CONSTRAINT "AdminUserRetirement_phase_check"
    CHECK ("phase" IN (
      'MANIFESTED',
      'ADMISSION_CLOSED',
      'OWNED_PROJECTS_RETIRED',
      'SHARED_ACTOR_STATE_RETIRED',
      'EXTERNAL_STATE_RETIRED',
      'EXTERNAL_ABSENCE_VERIFIED',
      'DATABASE_COMMITTED',
      'COMPLETE'
    )),
  CONSTRAINT "AdminUserRetirement_status_check"
    CHECK ("status" IN ('PENDING', 'RUNNING', 'BLOCKED', 'COMPLETE')),
  CONSTRAINT "AdminUserRetirement_complete_check"
    CHECK (
      ("status" = 'COMPLETE' AND "phase" = 'COMPLETE' AND "completedAt" IS NOT NULL)
      OR
      ("status" <> 'COMPLETE' AND "phase" <> 'COMPLETE' AND "completedAt" IS NULL)
    ),
  CONSTRAINT "AdminUserRetirement_lease_shape_check"
    CHECK (
      ("leaseTokenHash" IS NULL AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL)
      OR
      (
        "leaseTokenHash" ~ '^[a-f0-9]{64}$'
        AND length("leaseOwner") BETWEEN 1 AND 200
        AND "leaseExpiresAt" IS NOT NULL
      )
    ),
  CONSTRAINT "AdminUserRetirement_error_shape_check"
    CHECK (
      (
        "status" = 'BLOCKED'
        AND "lastErrorCode" IS NOT NULL
        AND "lastErrorDetail" IS NOT NULL
        AND "lastErrorCode" ~ '^[A-Za-z0-9_.-]{1,120}$'
        AND length("lastErrorDetail") BETWEEN 1 AND 500
      )
      OR
      (
        "status" <> 'BLOCKED'
        AND "lastErrorCode" IS NULL
        AND "lastErrorDetail" IS NULL
      )
    ),
  CONSTRAINT "AdminUserRetirement_absence_digest_check"
    CHECK (
      "externalAbsenceDigest" IS NULL
      OR "externalAbsenceDigest" ~ '^[a-f0-9]{64}$'
    ),
  CONSTRAINT "AdminUserRetirement_admission_evidence_digest_check"
    CHECK (
      "admissionEvidenceDigest" IS NULL
      OR "admissionEvidenceDigest" ~ '^[a-f0-9]{64}$'
    ),
  CONSTRAINT "AdminUserRetirement_closed_authorization_version_check"
    CHECK (
      "closedAuthorizationVersion" IS NULL
      OR "closedAuthorizationVersion" > "targetAuthorizationVersion"
    ),
  CONSTRAINT "AdminUserRetirement_admission_evidence_shape_check"
    CHECK (
      (
        "phase" = 'MANIFESTED'
        AND "admissionClosedAt" IS NULL
        AND "authorizationTransitionId" IS NULL
        AND "closedAuthorizationVersion" IS NULL
        AND "admissionEvidenceDigest" IS NULL
      )
      OR
      (
        "phase" <> 'MANIFESTED'
        AND "admissionClosedAt" IS NOT NULL
        AND length("authorizationTransitionId") BETWEEN 1 AND 200
        AND "closedAuthorizationVersion" IS NOT NULL
        AND "admissionEvidenceDigest" IS NOT NULL
      )
    ),
  CONSTRAINT "AdminUserRetirement_phase_evidence_check"
    CHECK (
      (
        "phase" IN (
          'EXTERNAL_ABSENCE_VERIFIED',
          'DATABASE_COMMITTED',
          'COMPLETE'
        )
        AND "externalAbsenceVerifiedAt" IS NOT NULL
        AND "externalAbsenceDigest" IS NOT NULL
      )
      OR
      (
        "phase" NOT IN (
          'EXTERNAL_ABSENCE_VERIFIED',
          'DATABASE_COMMITTED',
          'COMPLETE'
        )
      )
    ),
  CONSTRAINT "AdminUserRetirement_database_commit_check"
    CHECK (
      (
        "phase" IN ('DATABASE_COMMITTED', 'COMPLETE')
        AND "databaseCommittedAt" IS NOT NULL
      )
      OR
      "phase" NOT IN ('DATABASE_COMMITTED', 'COMPLETE')
    )
);

CREATE UNIQUE INDEX "AdminUserRetirement_targetUserId_key"
  ON "AdminUserRetirement"("targetUserId");
CREATE INDEX "AdminUserRetirement_status_leaseExpiresAt_idx"
  ON "AdminUserRetirement"("status", "leaseExpiresAt");
CREATE INDEX "AdminUserRetirement_requestedByUserId_idx"
  ON "AdminUserRetirement"("requestedByUserId");

CREATE OR REPLACE FUNCTION "AdminUserRetirement_preserve_manifest"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_phase_rank INTEGER;
  new_phase_rank INTEGER;
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."targetUserId" IS DISTINCT FROM OLD."targetUserId"
    OR NEW."requestedByUserId" IS DISTINCT FROM OLD."requestedByUserId"
    OR NEW."manifestVersion" IS DISTINCT FROM OLD."manifestVersion"
    OR NEW."manifest" IS DISTINCT FROM OLD."manifest"
    OR NEW."manifestDigest" IS DISTINCT FROM OLD."manifestDigest"
    OR NEW."targetAuthorizationVersion" IS DISTINCT FROM OLD."targetAuthorizationVersion"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR (
      OLD."admissionClosedAt" IS NOT NULL
      AND NEW."admissionClosedAt" IS DISTINCT FROM OLD."admissionClosedAt"
    )
    OR (
      OLD."authorizationTransitionId" IS NOT NULL
      AND NEW."authorizationTransitionId" IS DISTINCT FROM OLD."authorizationTransitionId"
    )
    OR (
      OLD."closedAuthorizationVersion" IS NOT NULL
      AND NEW."closedAuthorizationVersion" IS DISTINCT FROM OLD."closedAuthorizationVersion"
    )
    OR (
      OLD."admissionEvidenceDigest" IS NOT NULL
      AND NEW."admissionEvidenceDigest" IS DISTINCT FROM OLD."admissionEvidenceDigest"
    )
    OR (
      OLD."externalAbsenceDigest" IS NOT NULL
      AND NEW."externalAbsenceDigest" IS DISTINCT FROM OLD."externalAbsenceDigest"
    )
    OR (
      OLD."externalAbsenceVerifiedAt" IS NOT NULL
      AND NEW."externalAbsenceVerifiedAt" IS DISTINCT FROM OLD."externalAbsenceVerifiedAt"
    )
    OR (
      OLD."databaseCommittedAt" IS NOT NULL
      AND NEW."databaseCommittedAt" IS DISTINCT FROM OLD."databaseCommittedAt"
    )
    OR (
      OLD."completedAt" IS NOT NULL
      AND NEW."completedAt" IS DISTINCT FROM OLD."completedAt"
    )
  THEN
    RAISE EXCEPTION 'AdminUserRetirement immutable authority changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  old_phase_rank := array_position(
    ARRAY[
      'MANIFESTED',
      'ADMISSION_CLOSED',
      'OWNED_PROJECTS_RETIRED',
      'SHARED_ACTOR_STATE_RETIRED',
      'EXTERNAL_STATE_RETIRED',
      'EXTERNAL_ABSENCE_VERIFIED',
      'DATABASE_COMMITTED',
      'COMPLETE'
    ],
    OLD."phase"
  );
  new_phase_rank := array_position(
    ARRAY[
      'MANIFESTED',
      'ADMISSION_CLOSED',
      'OWNED_PROJECTS_RETIRED',
      'SHARED_ACTOR_STATE_RETIRED',
      'EXTERNAL_STATE_RETIRED',
      'EXTERNAL_ABSENCE_VERIFIED',
      'DATABASE_COMMITTED',
      'COMPLETE'
    ],
    NEW."phase"
  );
  IF new_phase_rank < old_phase_rank OR new_phase_rank > old_phase_rank + 1 THEN
    RAISE EXCEPTION 'AdminUserRetirement phase is not monotonic'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'AdminUserRetirement attempts cannot decrease'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" = 'COMPLETE'
    AND (
      NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."phase" IS DISTINCT FROM OLD."phase"
    )
  THEN
    RAISE EXCEPTION 'AdminUserRetirement completion is terminal'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "AdminUserRetirement_prevent_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AdminUserRetirement audit authority cannot be deleted'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE OR REPLACE FUNCTION "AdminUserRetirement_validate_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_role TEXT;
  target_username TEXT;
  target_authorization_version INTEGER;
  requester_role TEXT;
BEGIN
  IF NEW."manifest"->>'version' IS DISTINCT FROM NEW."manifestVersion"::TEXT
    OR NEW."manifest"->'target'->>'id' IS DISTINCT FROM NEW."targetUserId"
    OR NEW."manifest"->>'requestedByUserId' IS DISTINCT FROM NEW."requestedByUserId"
    OR NEW."manifest"->'target'->>'authorizationVersion'
      IS DISTINCT FROM NEW."targetAuthorizationVersion"::TEXT
  THEN
    RAISE EXCEPTION 'AdminUserRetirement manifest identity mismatch'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT "role"::TEXT, "username", "authorizationVersion"
    INTO target_role, target_username, target_authorization_version
    FROM "User"
    WHERE "id" = NEW."targetUserId"
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AdminUserRetirement target does not exist'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF target_role = 'OWNER' OR NEW."targetUserId" = NEW."requestedByUserId" THEN
    RAISE EXCEPTION 'AdminUserRetirement owner protection'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."manifest"->'target'->>'role' IS DISTINCT FROM target_role
    OR NEW."manifest"->'target'->>'username' IS DISTINCT FROM target_username
  THEN
    RAISE EXCEPTION 'AdminUserRetirement target snapshot changed'
      USING ERRCODE = 'serialization_failure';
  END IF;
  IF target_authorization_version IS DISTINCT FROM NEW."targetAuthorizationVersion" THEN
    RAISE EXCEPTION 'AdminUserRetirement target authorization generation changed'
      USING ERRCODE = 'serialization_failure';
  END IF;

  SELECT "role"::TEXT
    INTO requester_role
    FROM "User"
    WHERE "id" = NEW."requestedByUserId"
    FOR KEY SHARE;
  IF NOT FOUND OR requester_role <> 'OWNER' THEN
    RAISE EXCEPTION 'AdminUserRetirement requester is not the Owner'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AdminUserRetirement_validate_insert_trigger"
BEFORE INSERT ON "AdminUserRetirement"
FOR EACH ROW EXECUTE FUNCTION "AdminUserRetirement_validate_insert"();

CREATE TRIGGER "AdminUserRetirement_preserve_manifest_trigger"
BEFORE UPDATE ON "AdminUserRetirement"
FOR EACH ROW EXECUTE FUNCTION "AdminUserRetirement_preserve_manifest"();

CREATE TRIGGER "AdminUserRetirement_prevent_delete_trigger"
BEFORE DELETE ON "AdminUserRetirement"
FOR EACH ROW EXECUTE FUNCTION "AdminUserRetirement_prevent_delete"();

COMMIT;

BEGIN;

ALTER TABLE "ProjectAuthorizationTransition"
  DROP CONSTRAINT "ProjectAuthorizationTransition_kind_check";

ALTER TABLE "ProjectAuthorizationTransition"
  ADD CONSTRAINT "ProjectAuthorizationTransition_kind_check"
  CHECK ("kind" IN (
    'USER_AUTHORIZATION_UPDATE',
    'CREDENTIAL_RECOVERY',
    'OWNERSHIP_TRANSFER',
    'USER_RETIREMENT'
  ));

COMMIT;
