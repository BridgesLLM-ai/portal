-- Project Chat coordination is database-owned so process restarts, concurrent
-- tabs, and provider switches cannot create overlapping turns or stale
-- completions. The authenticated actor and immutable ProjectIdentity UUID are
-- the sole coordination key.

ALTER TABLE "ProjectChatProviderBinding"
  ADD COLUMN "handoffCursor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "handoffVersion" INTEGER NOT NULL DEFAULT 1;

CREATE TYPE "ProjectChatTurnStatus" AS ENUM (
  'RUNNING',
  'ABORTING',
  'COMPLETED',
  'ERROR',
  'ABORTED',
  'EXPIRED'
);

CREATE TABLE "ProjectChatState" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "projectIdentityId" TEXT NOT NULL,
  "selectedProvider" "AgentProviderType" NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "activeTurnId" TEXT,
  "transcriptCursor" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProjectChatState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectChatTurn" (
  "id" TEXT NOT NULL,
  "stateId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "projectIdentityId" TEXT NOT NULL,
  "activeProjectKey" TEXT,
  "provider" "AgentProviderType" NOT NULL,
  "runtime" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "status" "ProjectChatTurnStatus" NOT NULL DEFAULT 'RUNNING',
  "leaseTokenHash" TEXT NOT NULL,
  "leaseOwner" TEXT NOT NULL,
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "heartbeatAt" TIMESTAMP(3) NOT NULL,
  "providerSessionId" TEXT,
  "model" TEXT,
  "lastEventSeq" INTEGER NOT NULL DEFAULT 0,
  "resultMetadata" JSONB,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProjectChatTurn_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectChatTurnEvent" (
  "id" TEXT NOT NULL,
  "turnId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProjectChatTurnEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectChatState_actorUserId_projectIdentityId_key"
  ON "ProjectChatState"("actorUserId", "projectIdentityId");
CREATE UNIQUE INDEX "ProjectChatState_activeTurnId_key"
  ON "ProjectChatState"("activeTurnId");
CREATE INDEX "ProjectChatState_projectIdentityId_idx"
  ON "ProjectChatState"("projectIdentityId");
CREATE INDEX "ProjectChatState_selectedProvider_idx"
  ON "ProjectChatState"("selectedProvider");

CREATE UNIQUE INDEX "ProjectChatTurn_leaseTokenHash_key"
  ON "ProjectChatTurn"("leaseTokenHash");
CREATE UNIQUE INDEX "ProjectChatTurn_activeProjectKey_key"
  ON "ProjectChatTurn"("activeProjectKey");
CREATE UNIQUE INDEX "ProjectChatTurn_actorUserId_projectIdentityId_requestId_key"
  ON "ProjectChatTurn"("actorUserId", "projectIdentityId", "requestId");
CREATE INDEX "ProjectChatTurn_actorUserId_projectIdentityId_status_idx"
  ON "ProjectChatTurn"("actorUserId", "projectIdentityId", "status");
CREATE INDEX "ProjectChatTurn_stateId_createdAt_idx"
  ON "ProjectChatTurn"("stateId", "createdAt");
CREATE INDEX "ProjectChatTurn_leaseExpiresAt_status_idx"
  ON "ProjectChatTurn"("leaseExpiresAt", "status");

CREATE UNIQUE INDEX "ProjectChatTurnEvent_turnId_seq_key"
  ON "ProjectChatTurnEvent"("turnId", "seq");
CREATE INDEX "ProjectChatTurnEvent_turnId_createdAt_idx"
  ON "ProjectChatTurnEvent"("turnId", "createdAt");

ALTER TABLE "ProjectChatState"
  ADD CONSTRAINT "ProjectChatState_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectChatState"
  ADD CONSTRAINT "ProjectChatState_projectIdentityId_fkey"
  FOREIGN KEY ("projectIdentityId") REFERENCES "ProjectIdentity"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectChatTurn"
  ADD CONSTRAINT "ProjectChatTurn_stateId_fkey"
  FOREIGN KEY ("stateId") REFERENCES "ProjectChatState"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectChatTurn"
  ADD CONSTRAINT "ProjectChatTurn_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectChatTurn"
  ADD CONSTRAINT "ProjectChatTurn_projectIdentityId_fkey"
  FOREIGN KEY ("projectIdentityId") REFERENCES "ProjectIdentity"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectChatTurnEvent"
  ADD CONSTRAINT "ProjectChatTurnEvent_turnId_fkey"
  FOREIGN KEY ("turnId") REFERENCES "ProjectChatTurn"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
