-- Clear can delete external provider sessions before its SQL transcript reset
-- commits. Keep a durable privacy tombstone across crashes and generic runtime
-- admission finalization; the reset transaction removes it only after every
-- actor/project transcript and binding row is proven converged.
CREATE TABLE "ProjectChatDestructiveResetJournal" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "projectIdentityId" TEXT NOT NULL,
  "projectGeneration" INTEGER NOT NULL,
  "admissionTurnId" TEXT NOT NULL,
  "legacyProjectId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'RESETTING',
  "externalMutationStartedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectChatDestructiveResetJournal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectChatDestructiveResetJournal_status_check"
    CHECK ("status" = 'RESETTING'),
  CONSTRAINT "ProjectChatDestructiveResetJournal_generation_check"
    CHECK ("projectGeneration" > 0),
  CONSTRAINT "ProjectChatDestructiveResetJournal_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectChatDestructiveResetJournal_projectIdentityId_fkey"
    FOREIGN KEY ("projectIdentityId") REFERENCES "ProjectIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ProjectChatReset_actor_project_key"
  ON "ProjectChatDestructiveResetJournal"("actorUserId", "projectIdentityId");
CREATE INDEX "ProjectChatDestructiveResetJournal_projectIdentityId_status_idx"
  ON "ProjectChatDestructiveResetJournal"("projectIdentityId", "status");

CREATE TABLE "LegacyOpenClawProjectClearTombstone" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "projectIdentityId" TEXT NOT NULL,
  "projectGeneration" INTEGER NOT NULL,
  "admissionTurnId" TEXT NOT NULL,
  "sourceInventoryFingerprint" TEXT NOT NULL,
  "clearedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LegacyOpenClawProjectClearTombstone_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LegacyOpenClawProjectClearTombstone_generation_check"
    CHECK ("projectGeneration" > 0),
  CONSTRAINT "LegacyOpenClawProjectClearTombstone_fingerprint_check"
    CHECK (length("sourceInventoryFingerprint") = 64),
  CONSTRAINT "LegacyOpenClawProjectClearTombstone_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LegacyOpenClawProjectClearTombstone_projectIdentityId_fkey"
    FOREIGN KEY ("projectIdentityId") REFERENCES "ProjectIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "LegacyOpenClawProjectClear_actor_project_generation_key"
  ON "LegacyOpenClawProjectClearTombstone"("actorUserId", "projectIdentityId", "projectGeneration");
CREATE INDEX "LegacyOpenClawProjectClear_project_cleared_idx"
  ON "LegacyOpenClawProjectClearTombstone"("projectIdentityId", "clearedAt");

CREATE FUNCTION "attest_project_chat_destructive_reset"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId"
    OR NEW."projectIdentityId" IS DISTINCT FROM OLD."projectIdentityId"
    OR NEW."projectGeneration" IS DISTINCT FROM OLD."projectGeneration"
  ) THEN
    RAISE EXCEPTION 'immutable Project Chat reset provenance changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "ProjectIdentity"
    WHERE "id" = NEW."projectIdentityId"
      AND "generation" = NEW."projectGeneration"
      AND "lifecycleStatus" = 'ACTIVE'
      AND ("legacyOpenClawMigrationStatus" <> 'PENDING' OR TG_OP = 'UPDATE')
  ) THEN
    RAISE EXCEPTION 'Project Chat reset project generation was not active and attested';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "ProjectChatState"
    WHERE "actorUserId" = NEW."actorUserId"
      AND "projectIdentityId" = NEW."projectIdentityId"
      AND "activeTurnId" = NEW."admissionTurnId"
  ) THEN
    RAISE EXCEPTION 'Project Chat reset admission was not actor-attested';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectChatDestructiveResetJournal_attest_provenance"
BEFORE INSERT OR UPDATE ON "ProjectChatDestructiveResetJournal"
FOR EACH ROW EXECUTE FUNCTION "attest_project_chat_destructive_reset"();

CREATE FUNCTION "attest_legacy_project_clear_tombstone"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "ProjectIdentity"
    WHERE "id" = NEW."projectIdentityId"
      AND "generation" = NEW."projectGeneration"
      AND "lifecycleStatus" = 'ACTIVE'
  ) OR NOT EXISTS (
    SELECT 1
    FROM "ProjectChatState"
    WHERE "actorUserId" = NEW."actorUserId"
      AND "projectIdentityId" = NEW."projectIdentityId"
      AND "activeTurnId" = NEW."admissionTurnId"
  ) THEN
    RAISE EXCEPTION 'legacy Project clear tombstone was not admission-attested';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "LegacyOpenClawProjectClearTombstone_attest"
BEFORE INSERT ON "LegacyOpenClawProjectClearTombstone"
FOR EACH ROW EXECUTE FUNCTION "attest_legacy_project_clear_tombstone"();

CREATE FUNCTION "keep_legacy_project_clear_tombstone_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'immutable legacy Project clear tombstone changed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "LegacyOpenClawProjectClearTombstone_immutable"
BEFORE UPDATE ON "LegacyOpenClawProjectClearTombstone"
FOR EACH ROW EXECUTE FUNCTION "keep_legacy_project_clear_tombstone_immutable"();

-- Lifecycle and importer transitions must serialize against a reset that may
-- already have deleted external provider history. This closes the independent
-- backend-process race that a route-level check cannot cover.
CREATE FUNCTION "fence_project_identity_during_chat_reset"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected_identity_id TEXT;
BEGIN
  affected_identity_id := OLD."id";
  IF TG_OP = 'UPDATE' AND NOT (
    NEW."workspaceOwnerId" IS DISTINCT FROM OLD."workspaceOwnerId"
    OR NEW."projectName" IS DISTINCT FROM OLD."projectName"
    OR NEW."canonicalRoot" IS DISTINCT FROM OLD."canonicalRoot"
    OR NEW."generation" IS DISTINCT FROM OLD."generation"
    OR NEW."lifecycleStatus" IS DISTINCT FROM OLD."lifecycleStatus"
    OR NEW."legacyOpenClawMigrationStatus" IS DISTINCT FROM OLD."legacyOpenClawMigrationStatus"
  ) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ProjectChatDestructiveResetJournal"
    WHERE "projectIdentityId" = affected_identity_id
      AND "status" = 'RESETTING'
  ) THEN
    RAISE EXCEPTION 'Project lifecycle transition blocked by Project Chat reset';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectIdentity_fence_chat_reset"
BEFORE UPDATE OR DELETE ON "ProjectIdentity"
FOR EACH ROW EXECUTE FUNCTION "fence_project_identity_during_chat_reset"();
