CREATE TABLE "ProjectWorkCard" (
  "id" TEXT PRIMARY KEY,
  "actorUserId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "actorAuthorizationVersion" INTEGER NOT NULL,
  "originProvider" TEXT NOT NULL,
  "originSessionKey" TEXT NOT NULL,
  "projectIdentityId" TEXT NOT NULL REFERENCES "ProjectIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "projectGeneration" INTEGER NOT NULL CHECK ("projectGeneration" > 0),
  "projectName" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT,
  "requestId" TEXT NOT NULL UNIQUE,
  "prompt" TEXT NOT NULL CHECK (length("prompt") BETWEEN 1 AND 24000),
  "parentCardId" TEXT,
  "sessionId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "portalInstanceId" TEXT,
  "response" TEXT NOT NULL DEFAULT '',
  "events" JSONB,
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ProjectWorkCard_origin_idx" ON "ProjectWorkCard" ("actorUserId", "originProvider", "originSessionKey", "createdAt");
CREATE INDEX "ProjectWorkCard_actorUserId_projectIdentityId_idx" ON "ProjectWorkCard" ("actorUserId", "projectIdentityId");
-- Single writer admission, not a background queue. A second request is refused.
CREATE UNIQUE INDEX "ProjectWorkCard_one_active" ON "ProjectWorkCard" ("actorUserId", "projectIdentityId") WHERE "status" IN ('STARTING', 'RUNNING', 'UNCERTAIN');
