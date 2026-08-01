-- Portal 3.x stored a partial SQL projection while OpenClaw retained the
-- canonical transcript. These columns keep imported event provenance stable
-- across retries and equal-millisecond ordering.
ALTER TABLE "ProjectIdentity"
  ADD COLUMN "legacyOpenClawMigrationStatus" TEXT NOT NULL DEFAULT 'NONE',
  ADD CONSTRAINT "ProjectIdentity_legacyOpenClawMigrationStatus_check"
    CHECK ("legacyOpenClawMigrationStatus" IN ('NONE', 'PENDING', 'COMPLETE'));

ALTER TABLE "ProjectChatMessage"
  ADD COLUMN "sourceOrdinal" INTEGER,
  ADD COLUMN "sourceKeyHash" TEXT,
  ADD COLUMN "sourceEventId" TEXT,
  ADD COLUMN "sourceEventSeq" INTEGER,
  ADD COLUMN "sourceProjectionIndex" INTEGER,
  ADD COLUMN "sourceFingerprint" TEXT,
  ADD COLUMN "sourceSortKey" TEXT,
  ADD COLUMN "legacyImportStatus" TEXT;

ALTER TABLE "ProjectChatMessage"
  ADD CONSTRAINT "ProjectChatMessage_legacyImportStatus_check"
    CHECK ("legacyImportStatus" IS NULL OR "legacyImportStatus" = 'IMPORTED'),
  ADD CONSTRAINT "ProjectChatMessage_legacy_source_ordinals_check"
    CHECK (
      ("sourceOrdinal" IS NULL OR "sourceOrdinal" >= 0)
      AND ("sourceEventSeq" IS NULL OR "sourceEventSeq" > 0)
      AND ("sourceProjectionIndex" IS NULL OR "sourceProjectionIndex" >= 0)
    ),
  ADD CONSTRAINT "ProjectChatMessage_imported_provenance_check"
    CHECK (
      "legacyImportStatus" IS DISTINCT FROM 'IMPORTED'
      OR (
        "messageId" IS NOT NULL
        AND "messageId" LIKE 'legacy-openclaw:%'
        AND "provider" = 'OPENCLAW'
        AND "providerSessionId" IS NOT NULL
        AND "sourceOrdinal" IS NOT NULL
        AND "sourceKeyHash" IS NOT NULL
        AND "sourceEventId" IS NOT NULL
        AND "sourceEventSeq" IS NOT NULL
        AND "sourceProjectionIndex" IS NOT NULL
        AND "sourceFingerprint" IS NOT NULL
        AND "sourceSortKey" IS NOT NULL
      )
    );

CREATE INDEX "ProjectChatMessage_userId_projectId_timestamp_sourceSortKey_idx"
  ON "ProjectChatMessage"("userId", "projectId", "timestamp", "sourceSortKey");

-- Close the database write boundary as soon as an identity enters PENDING.
-- Native callbacks from another Portal process must not append or rewrite the
-- legacy projection while the importer is reconciling it. Import rows are the
-- only admitted writes; their full provenance is attested below in the same
-- migration transaction.
CREATE FUNCTION "fence_project_chat_message_legacy_import"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."legacyImportStatus" = 'IMPORTED' THEN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'immutable imported legacy Project Chat projection changed';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."legacyImportStatus" = 'IMPORTED' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "ProjectIdentity"
    WHERE "id" = NEW."projectId"
      AND "legacyOpenClawMigrationStatus" = 'PENDING'
  ) THEN
    RAISE EXCEPTION 'Project Chat message write blocked by legacy OpenClaw import';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectChatMessage_fence_legacy_import"
BEFORE INSERT OR UPDATE ON "ProjectChatMessage"
FOR EACH ROW EXECUTE FUNCTION "fence_project_chat_message_legacy_import"();

-- A per-source completion record is committed in the same Serializable
-- transaction as reconciliation. Exact source locators are retained because a
-- digest cannot prove that a registration is absent after a crash.
CREATE TABLE "LegacyOpenClawProjectImport" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "projectIdentityId" TEXT NOT NULL,
  "projectGeneration" INTEGER NOT NULL,
  "candidateAgentId" TEXT NOT NULL,
  "candidateAgentHash" TEXT NOT NULL,
  "sourceAgentId" TEXT NOT NULL,
  "sourceAgentHash" TEXT NOT NULL,
  "sourceSessionKey" TEXT NOT NULL,
  "sessionKeyHash" TEXT NOT NULL,
  "sourceKind" TEXT NOT NULL,
  "sourceStatus" TEXT NOT NULL,
  "providerSessionId" TEXT NOT NULL,
  "providerSessionIdHash" TEXT NOT NULL,
  "sourceFingerprint" TEXT NOT NULL,
  "artifactInventoryFingerprint" TEXT NOT NULL,
  "agentInventoryFingerprint" TEXT NOT NULL,
  "totalMessages" INTEGER NOT NULL,
  "importedMessages" INTEGER NOT NULL,
  "transcriptDigest" TEXT NOT NULL,
  "projectionDigest" TEXT NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL,
  "retiredAt" TIMESTAMP(3),
  "clearedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LegacyOpenClawProjectImport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LegacyOpenClawProjectImport_sourceKind_check"
    CHECK ("sourceKind" IN ('DEDICATED', 'SHARED_PORTAL')),
  CONSTRAINT "LegacyOpenClawProjectImport_sourceStatus_check"
    CHECK ("sourceStatus" IN ('COMPLETE', 'RETIRED', 'CLEARED')),
  CONSTRAINT "LegacyOpenClawProjectImport_message_counts_check"
    CHECK ("totalMessages" >= 0 AND "importedMessages" >= 0 AND "importedMessages" <= "totalMessages"),
  CONSTRAINT "LegacyOpenClawProjectImport_generation_check"
    CHECK ("projectGeneration" > 0),
  CONSTRAINT "LegacyOpenClawProjectImport_lifecycle_check"
    CHECK (
      ("sourceStatus" = 'COMPLETE' AND "retiredAt" IS NULL AND "clearedAt" IS NULL)
      OR ("sourceStatus" = 'RETIRED' AND "retiredAt" IS NOT NULL AND "clearedAt" IS NULL)
      OR ("sourceStatus" = 'CLEARED' AND "retiredAt" IS NOT NULL AND "clearedAt" IS NOT NULL)
    ),
  CONSTRAINT "LegacyOpenClawProjectImport_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LegacyOpenClawProjectImport_projectIdentityId_fkey"
    FOREIGN KEY ("projectIdentityId") REFERENCES "ProjectIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "LegacyOpenClawProjectImport_actor_project_session_key"
  ON "LegacyOpenClawProjectImport"("actorUserId", "projectIdentityId", "sessionKeyHash");
CREATE UNIQUE INDEX "LegacyOpenClawProjectImport_actor_source_session_key"
  ON "LegacyOpenClawProjectImport"("actorUserId", "sourceAgentHash", "sessionKeyHash");
CREATE INDEX "LegacyOpenClawProjectImport_projectIdentityId_sourceStatus_idx"
  ON "LegacyOpenClawProjectImport"("projectIdentityId", "sourceStatus");
CREATE INDEX "LegacyOpenClawProjectImport_actor_project_generation_idx"
  ON "LegacyOpenClawProjectImport"("actorUserId", "projectIdentityId", "projectGeneration");

-- Import admission and destructive Project lifecycle admission serialize on
-- the same ProjectIdentity row. Once PENDING wins, rename/delete/root changes
-- cannot begin until the importer commits COMPLETE; if lifecycle wins first,
-- the importer's ACTIVE+PENDING transition CAS fails instead.
CREATE FUNCTION "fence_project_identity_during_legacy_openclaw_import"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."legacyOpenClawMigrationStatus" <> 'PENDING' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Project lifecycle transition blocked by legacy OpenClaw import';
  END IF;
  IF NEW."lifecycleStatus" IS DISTINCT FROM OLD."lifecycleStatus"
    OR NEW."workspaceOwnerId" IS DISTINCT FROM OLD."workspaceOwnerId"
    OR NEW."projectName" IS DISTINCT FROM OLD."projectName"
    OR NEW."canonicalRoot" IS DISTINCT FROM OLD."canonicalRoot"
    OR NEW."rootDevice" IS DISTINCT FROM OLD."rootDevice"
    OR NEW."rootInode" IS DISTINCT FROM OLD."rootInode"
    OR NEW."rootBirthtimeNs" IS DISTINCT FROM OLD."rootBirthtimeNs"
    OR NEW."generation" IS DISTINCT FROM OLD."generation" THEN
    RAISE EXCEPTION 'Project lifecycle transition blocked by legacy OpenClaw import';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ProjectIdentity_fence_legacy_openclaw_import"
BEFORE UPDATE OR DELETE ON "ProjectIdentity"
FOR EACH ROW EXECUTE FUNCTION "fence_project_identity_during_legacy_openclaw_import"();

-- Actor ownership and generation are attested when immutable provenance is
-- created. ProjectIdentity.generation changes on rename, so this deliberately
-- is not a cascading foreign key to the live generation value. Identity fields
-- cannot be rewritten later; lifecycle-only updates remain valid after rename.
CREATE FUNCTION "attest_legacy_project_provenance"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'LegacyOpenClawProjectQuarantine' THEN
      IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION 'immutable legacy quarantine payload changed';
      END IF;
      RETURN NEW;
    END IF;

    IF (to_jsonb(NEW) - 'updatedAt' - 'sourceStatus' - 'retiredAt' - 'clearedAt')
      IS DISTINCT FROM
      (to_jsonb(OLD) - 'updatedAt' - 'sourceStatus' - 'retiredAt' - 'clearedAt') THEN
      RAISE EXCEPTION 'immutable legacy import proof changed';
    END IF;
    IF NEW."sourceStatus" = OLD."sourceStatus"
      AND NEW."retiredAt" IS NOT DISTINCT FROM OLD."retiredAt"
      AND NEW."clearedAt" IS NOT DISTINCT FROM OLD."clearedAt" THEN
      RETURN NEW;
    END IF;
    IF OLD."sourceStatus" = 'COMPLETE'
      AND OLD."retiredAt" IS NULL
      AND NEW."sourceStatus" = 'RETIRED'
      AND NEW."retiredAt" IS NOT NULL
      AND NEW."clearedAt" IS NULL THEN
      RETURN NEW;
    END IF;
    IF OLD."sourceStatus" = 'RETIRED'
      AND OLD."retiredAt" IS NOT NULL
      AND OLD."clearedAt" IS NULL
      AND NEW."sourceStatus" = 'CLEARED'
      AND NEW."retiredAt" IS NOT DISTINCT FROM OLD."retiredAt"
      AND NEW."clearedAt" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'invalid legacy import proof lifecycle transition';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "ProjectIdentity"
    WHERE "id" = NEW."projectIdentityId"
      AND "workspaceOwnerId" = NEW."actorUserId"
      AND "generation" = NEW."projectGeneration"
      AND "lifecycleStatus" = 'ACTIVE'
      AND "legacyOpenClawMigrationStatus" = 'PENDING'
  ) THEN
    RAISE EXCEPTION 'legacy project provenance was not current and owner-attested';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "LegacyOpenClawProjectImport_attest_provenance"
BEFORE INSERT OR UPDATE ON "LegacyOpenClawProjectImport"
FOR EACH ROW EXECUTE FUNCTION "attest_legacy_project_provenance"();

-- Unmatched SQL rows are deliberately non-visible. Portal 3.x wrote SQL before
-- the Gateway send and also left rows behind after Clear, so absence from the
-- canonical snapshot is not enough to decide which history the user intended.
CREATE TABLE "LegacyOpenClawProjectQuarantine" (
  "id" TEXT NOT NULL,
  "originalMessageId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "projectIdentityId" TEXT NOT NULL,
  "projectGeneration" INTEGER NOT NULL,
  "originalProjectId" TEXT NOT NULL,
  "sessionKey" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "timestamp" TIMESTAMP(3) NOT NULL,
  "messageId" TEXT,
  "provider" TEXT NOT NULL,
  "runtime" TEXT NOT NULL,
  "model" TEXT,
  "providerSessionId" TEXT,
  "reason" TEXT NOT NULL,
  "payloadDigest" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LegacyOpenClawProjectQuarantine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LegacyOpenClawProjectQuarantine_reason_check"
    CHECK ("reason" IN ('UNMATCHED_SQL')),
  CONSTRAINT "LegacyOpenClawProjectQuarantine_generation_check"
    CHECK ("projectGeneration" > 0),
  CONSTRAINT "LegacyOpenClawProjectQuarantine_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LegacyOpenClawProjectQuarantine_projectIdentityId_fkey"
    FOREIGN KEY ("projectIdentityId") REFERENCES "ProjectIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "LegacyOpenClawProjectQuarantine_originalMessageId_key"
  ON "LegacyOpenClawProjectQuarantine"("originalMessageId");
CREATE INDEX "LegacyOpenClawProjectQuarantine_actor_project_idx"
  ON "LegacyOpenClawProjectQuarantine"("actorUserId", "projectIdentityId");
CREATE INDEX "LegacyOpenClawProjectQuarantine_project_reason_idx"
  ON "LegacyOpenClawProjectQuarantine"("projectIdentityId", "reason");

CREATE TRIGGER "LegacyOpenClawProjectQuarantine_attest_provenance"
BEFORE INSERT OR UPDATE ON "LegacyOpenClawProjectQuarantine"
FOR EACH ROW EXECUTE FUNCTION "attest_legacy_project_provenance"();

-- Only one backend process may run the destructive retirement coordinator.
CREATE TABLE "LegacyOpenClawProjectMigrationLease" (
  "id" TEXT NOT NULL,
  "leaseTokenHash" TEXT NOT NULL,
  "leaseOwner" TEXT NOT NULL,
  "phase" TEXT NOT NULL DEFAULT 'DISCOVERING',
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "heartbeatAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LegacyOpenClawProjectMigrationLease_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LegacyOpenClawProjectMigrationLease_phase_check"
    CHECK ("phase" IN ('DISCOVERING', 'MIGRATING'))
);

CREATE INDEX "LegacyOpenClawProjectMigrationLease_leaseExpiresAt_idx"
  ON "LegacyOpenClawProjectMigrationLease"("leaseExpiresAt");
