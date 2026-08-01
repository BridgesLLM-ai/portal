-- Project rename is a durable lifecycle operation, not a best-effort filesystem
-- move. These nullable fields keep the admission barrier recoverable across a
-- Portal crash without changing existing ACTIVE/DELETING identities.
ALTER TABLE "ProjectIdentity"
  ADD COLUMN "renameTargetName" TEXT,
  ADD COLUMN "renameLeaseTokenHash" TEXT,
  ADD COLUMN "renameLeaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "renameStartedAt" TIMESTAMP(3),
  ADD COLUMN "renameCleanupStartedAt" TIMESTAMP(3),
  ADD COLUMN "renameRuntimeCleanedAt" TIMESTAMP(3),
  ADD COLUMN "renameDeployPresent" BOOLEAN,
  ADD COLUMN "renameDeployDevice" TEXT,
  ADD COLUMN "renameDeployInode" TEXT,
  ADD COLUMN "renameDeployBirthtimeNs" TEXT,
  ADD COLUMN "lastRenameSourceName" TEXT,
  ADD COLUMN "lastRenameCompletedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "ProjectIdentity_workspaceOwnerId_renameTargetName_key"
  ON "ProjectIdentity"("workspaceOwnerId", "renameTargetName");

-- A pair of independent unique indexes cannot prevent process A from creating
-- projectName=X while process B reserves renameTargetName=X. Normalize both
-- values into one keyspace whose primary key serializes that race in Postgres.
CREATE TABLE "ProjectNameReservation" (
  "workspaceOwnerId" TEXT NOT NULL,
  "projectName" TEXT NOT NULL,
  "projectIdentityId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  CONSTRAINT "ProjectNameReservation_pkey" PRIMARY KEY ("workspaceOwnerId", "projectName"),
  CONSTRAINT "ProjectNameReservation_kind_check" CHECK ("kind" IN ('CURRENT', 'TARGET')),
  CONSTRAINT "ProjectNameReservation_projectIdentityId_fkey"
    FOREIGN KEY ("projectIdentityId") REFERENCES "ProjectIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ProjectNameReservation_projectIdentityId_kind_key"
  ON "ProjectNameReservation"("projectIdentityId", "kind");
CREATE INDEX "ProjectNameReservation_projectIdentityId_idx"
  ON "ProjectNameReservation"("projectIdentityId");

INSERT INTO "ProjectNameReservation" ("workspaceOwnerId", "projectName", "projectIdentityId", "kind")
SELECT "workspaceOwnerId", "projectName", "id", 'CURRENT'
FROM "ProjectIdentity"
UNION ALL
SELECT "workspaceOwnerId", "renameTargetName", "id", 'TARGET'
FROM "ProjectIdentity"
WHERE "renameTargetName" IS NOT NULL;

-- Project-generated App rows are tied to the immutable identity. Standalone
-- uploads remain NULL and may legitimately share a display name.
ALTER TABLE "App" ADD COLUMN "projectIdentityId" TEXT;

UPDATE "App" AS app
SET "projectIdentityId" = identity."id"
FROM "ProjectIdentity" AS identity
WHERE app."userId" = identity."workspaceOwnerId"
  AND app."name" = identity."projectName"
  AND (
    app."zipPath" = '/var/www/bridgesllm-apps/' || app."userId" || '-' || app."name"
    OR app."zipPath" = '/opt/bridgesllm/apps/' || app."userId" || '-' || app."name"
    OR (
      app."deployType" = 'runtime'
      AND app."zipPath" IN (
        '/var/lib/bridgesllm/desktop-projects/' || identity."id",
        '/home/bridgesrd/projects/' || identity."id",
        '/home/bridgesrd/projects/' || app."name"
      )
    )
  );

ALTER TABLE "App"
  ADD CONSTRAINT "App_projectIdentityId_fkey"
  FOREIGN KEY ("projectIdentityId") REFERENCES "ProjectIdentity"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one durable App record belongs to a Project identity. PostgreSQL
-- permits multiple NULLs, so unrelated standalone Apps remain unassociated.
CREATE UNIQUE INDEX "App_projectIdentityId_key" ON "App"("projectIdentityId");

CREATE FUNCTION "enforceProjectAppIdentity"() RETURNS TRIGGER AS $$
DECLARE
  expected_owner TEXT;
  expected_name TEXT;
BEGIN
  IF NEW."projectIdentityId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "workspaceOwnerId", "projectName"
  INTO expected_owner, expected_name
  FROM "ProjectIdentity"
  WHERE "id" = NEW."projectIdentityId"
  FOR UPDATE;
  IF NOT FOUND
    OR NEW."userId" IS DISTINCT FROM expected_owner
    OR NEW."name" IS DISTINCT FROM expected_name THEN
    RAISE EXCEPTION 'Project App identity does not match its immutable Project'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "App_enforce_project_identity"
BEFORE INSERT OR UPDATE OF "projectIdentityId", "userId", "name"
ON "App"
FOR EACH ROW EXECUTE FUNCTION "enforceProjectAppIdentity"();

CREATE FUNCTION "syncProjectNameReservations"() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM "ProjectNameReservation" WHERE "projectIdentityId" = NEW."id";
  INSERT INTO "ProjectNameReservation" ("workspaceOwnerId", "projectName", "projectIdentityId", "kind")
  VALUES (NEW."workspaceOwnerId", NEW."projectName", NEW."id", 'CURRENT');
  IF NEW."renameTargetName" IS NOT NULL THEN
    INSERT INTO "ProjectNameReservation" ("workspaceOwnerId", "projectName", "projectIdentityId", "kind")
    VALUES (NEW."workspaceOwnerId", NEW."renameTargetName", NEW."id", 'TARGET');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProjectIdentity_sync_name_reservations"
AFTER INSERT OR UPDATE OF "workspaceOwnerId", "projectName", "renameTargetName"
ON "ProjectIdentity"
FOR EACH ROW EXECUTE FUNCTION "syncProjectNameReservations"();

CREATE TABLE "ProjectRuntimeCleanupActor" (
  "projectIdentityId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectRuntimeCleanupActor_pkey"
    PRIMARY KEY ("projectIdentityId", "provider", "actorUserId", "sessionId"),
  CONSTRAINT "ProjectRuntimeCleanupActor_provider_check"
    CHECK ("provider" IN ('OPENCLAW', 'CLAUDE_CODE', 'CODEX', 'AGENT_ZERO', 'GEMINI', 'OLLAMA', 'GROK_BUILD')),
  CONSTRAINT "ProjectRuntimeCleanupActor_projectIdentityId_fkey"
    FOREIGN KEY ("projectIdentityId") REFERENCES "ProjectIdentity"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ProjectRuntimeCleanupActor_projectIdentityId_idx"
  ON "ProjectRuntimeCleanupActor"("projectIdentityId");
